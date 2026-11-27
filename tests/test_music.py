"""Compose, check, save, play and export tracks through the real engine."""

import os
import time
import wave

import pytest

from vis_music.errors import MusicError


@pytest.fixture
def track(samples):
    return (
        f"samples({{ click: ['click.wav'] }}, '{samples}')\n"
        "setcpm(120/4)\n"
        'drums: s("click*4")\n'
        'lead: note("c3 e3 g3 b3").s("sawtooth").lpf(1200).gain(.4)\n'
        '_off: note("c5").s("sine")\n'
    )


def _wav(path):
    with wave.open(str(path), "rb") as source:
        return source.getframerate(), source.getnchannels(), source.getnframes()


def test_check_lists_layers_tempo_and_the_muted_layer(music, track):
    info = music.check(track)
    assert [(layer.name, layer.is_muted) for layer in info.layers] == [
        ("drums", False),
        ("lead", False),
        ("_off", True),
    ]
    assert info.cps == 0.5
    assert info.events_in_4_cycles == 32
    assert info.warnings == ()


def test_code_that_does_not_compile_raises_the_compiler_message(music):
    with pytest.raises(MusicError, match="Unexpected"):
        music.check('drums: s("bd*4"')


def test_an_unknown_sound_is_a_warning(music):
    info = music.check('$: s("nosuchsound*2")')
    assert any("nosuchsound" in warning for warning in info.warnings)


def test_save_writes_only_a_track_that_compiles(music, track, tmp_path):
    saved = music.save(str(tmp_path / "songs" / "demo"), track)
    assert saved.is_saved and saved.source.endswith("demo.strudel")
    assert open(saved.source).read() == track
    assert [layer.name for layer in music.check(saved.source).layers] == ["drums", "lead", "_off"]
    with pytest.raises(MusicError):
        music.save(str(tmp_path / "broken.strudel"), "drums: s(")
    assert not (tmp_path / "broken.strudel").exists()
    with pytest.raises(FileExistsError):
        music.save(saved.source, track, overwrite=False)


def test_a_missing_track_file_is_not_read_as_code(music, tmp_path):
    with pytest.raises(FileNotFoundError):
        music.check(str(tmp_path / "missing.strudel"))


def test_events_of_one_layer(music, track):
    result = music.events(track, layers=["lead"], begin=0, end=1)
    assert result.layers == ("lead",)
    assert [event.value["note"] for event in result.events] == ["c3", "e3", "g3", "b3"]
    assert [event.time for event in result.events] == [0, 0.5, 1, 1.5]
    with pytest.raises(MusicError, match="unknown layer: nope"):
        music.events(track, layers=["nope"])


def test_export_wav_renders_the_unmuted_layers(music, track, tmp_path):
    result = music.export(track, str(tmp_path / "out" / "demo.wav"), cycles=4, tail=1)
    (file,) = result.files
    assert file.layer is None and file.events == 32
    assert file.seconds == 9 and 0.05 < file.peak < 1 and file.rms > 0
    assert _wav(file.path) == (44100, 2, 9 * 44100)


def test_export_one_muted_layer_by_name(music, track, tmp_path):
    (file,) = music.export(track, str(tmp_path / "off.wav"), layers=["_off"], cycles=2, tail=0).files
    assert file.events == 2 and file.peak > 0


def test_export_mp3(music, track, tmp_path):
    (file,) = music.export(track, str(tmp_path / "demo.mp3"), cycles=2).files
    head = open(file.path, "rb").read(3)
    assert head == b"ID3" or head[0] == 0xFF
    assert file.size_bytes > 10_000


def test_export_stems_writes_one_file_for_each_layer(music, track, tmp_path):
    result = music.export(track, str(tmp_path / "song.wav"), cycles=2, stems=True)
    assert [(os.path.basename(f.path), f.layer) for f in result.files] == [
        ("song.drums.wav", "drums"),
        ("song.lead.wav", "lead"),
    ]
    assert not (tmp_path / "song.wav").exists()
    assert all(f.peak > 0 for f in result.files)


def test_an_unknown_format_fails_before_the_render(music, track, tmp_path):
    with pytest.raises(MusicError, match=r"\.xyz"):
        music.export(track, str(tmp_path / "demo.xyz"))


def test_sounds_lists_the_synths(music):
    assert {"sawtooth", "sine", "square", "triangle"} <= set(music.sounds().synths)


@pytest.mark.skipif(bool(os.environ.get("VIS_MUSIC_NO_AUDIO")), reason="no audio device")
def test_play_switches_layers_without_a_restart_and_stops(music, track):
    started = music.play(track.replace(".gain(.4)", ".gain(0)"), layers=["lead"])
    assert started.is_playing and [layer.name for layer in started.layers if layer.is_playing] == ["lead"]
    time.sleep(1.2)
    switched = music.play(track.replace(".gain(.4)", ".gain(0)"), layers=["drums"])
    assert switched.is_changed and switched.cycle >= 0.4
    assert [layer.name for layer in switched.layers if layer.is_playing] == ["drums"]
    assert music.status().events_sent > 0
    assert music.stop().is_playing is False
    assert music.status().is_playing is False
