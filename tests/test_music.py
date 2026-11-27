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


@pytest.mark.skipif(not os.environ.get("VIS_MUSIC_NO_AUDIO"), reason="this machine has an audio device")
def test_play_without_an_audio_device_says_so(music, track):
    with pytest.raises(MusicError, match="no audio output device"):
        music.play(track)
    assert music.status().is_playing is False


@pytest.mark.skipif(bool(os.environ.get("VIS_MUSIC_NO_AUDIO")), reason="no audio device")
def test_play_switches_layers_without_a_restart_and_stops(music, track):
    started = music.play(track.replace(".gain(.4)", ".gain(0)"), layers=["lead"])
    assert started.is_playing and [layer.name for layer in started.layers if layer.is_playing] == ["lead"]
    time.sleep(1.2)
    switched = music.play(track.replace(".gain(.4)", ".gain(0)"), layers=["drums"])
    assert switched.is_changed and switched.cycle >= 0.4
    assert [layer.name for layer in switched.layers if layer.is_playing] == ["drums"]
    assert music.status().events_sent > 0 and music.status().output
    stopped = music.stop()
    assert stopped.is_playing is False and not any(layer.is_playing for layer in stopped.layers)
    assert music.status().is_playing is False


def test_a_sample_url_with_escaped_characters_loads_over_http(music, tmp_path):
    import functools
    import http.server
    import threading

    from conftest import write_click

    write_click(tmp_path / "F#4, soft.wav")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path))
    handler.log_message = lambda *args: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_port}/"
        code = f"samples({{ odd: ['F%234%2C%20soft.wav'] }}, '{base}')\n$: s(\"odd*2\")"
        result = music.export(code, str(tmp_path / "odd.wav"), cycles=1, tail=0)
    finally:
        server.shutdown()
    assert result.warnings == ()
    assert result.files[0].events == 2 and result.files[0].peak > 0


def test_samples_that_load_together_keep_their_own_sound(music, tmp_path):
    from conftest import write_click

    write_click(tmp_path / "loud.wav")
    with wave.open(str(tmp_path / "silent.wav"), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(44100)
        out.writeframes(b"\0\0" * 4410)
    base = tmp_path.as_uri() + "/"
    head = f"samples({{ loud: ['loud.wav'], silent: ['silent.wav'] }}, '{base}')\n"

    def render(body):
        (file,) = music.export(head + body, str(tmp_path / "mix.wav"), cycles=2, tail=0).files
        return file.peak, file.rms

    alone = render('a: s("loud*4")')
    assert alone[0] > 0.1
    assert render('a: s("loud*4")\nb: s("silent*4")') == alone
    assert render('b: s("silent*4")\na: s("loud*4")') == alone


def test_a_double_quoted_sample_source_is_a_plain_string(music, tmp_path):
    import json

    from conftest import write_click

    write_click(tmp_path / "click.wav")
    (tmp_path / "strudel.json").write_text(json.dumps({"_base": tmp_path.as_uri() + "/", "tick": ["click.wav"]}))
    info = music.check(f'samples("{(tmp_path / "strudel.json").as_uri()}")\n$: s("tick*4")')
    assert info.warnings == () and info.events_in_4_cycles == 16


def test_visual_methods_from_strudel_cc_draw_nothing(music):
    info = music.check('note("c3 e3").s("sine").pianoroll()._punchcard({ labels: 1 }).scope()')
    assert info.events_in_4_cycles == 8


def test_strudel_effects_and_synths_play_without_warnings(music, tmp_path):
    code = 'note("c3 e3").s("supersaw").detune(.5).vowel("a").shape(.4).crush(6).room(.3).size(3)'
    assert music.check(code).warnings == ()
    (file,) = music.export(code, str(tmp_path / "fx.wav"), cycles=1, tail=0).files
    assert file.events == 2 and file.peak > 0.05


def test_a_long_note_outlasts_many_short_ones_in_an_export(music, samples, tmp_path):
    code = (
        f"samples({{ click: ['click.wav'] }}, '{samples}')\n"
        "setcps(1)\n"
        'pad: note("c3/4").s("sine").release(0)\n'
        'clicks: s("click*64").gain(0)\n'
    )
    (file,) = music.export(code, str(tmp_path / "pad.wav"), cycles=4, tail=0).files
    assert file.events == 257
    with wave.open(file.path, "rb") as source:
        source.setpos(int(3.5 * 44100))
        frames = source.readframes(4410)
    values = [abs(int.from_bytes(frames[i : i + 2], "little", signed=True)) for i in range(0, len(frames), 4)]
    assert max(values) > 1000


def test_a_chord_that_strudel_does_not_know_is_a_warning_every_time(music):
    code = 'setcpm(30)\n$: chord("<Cmaj7 Am7>").voicing().s("sine")'
    for _ in range(2):
        assert any('unknown chord "Cmaj7"' in warning for warning in music.check(code).warnings)
