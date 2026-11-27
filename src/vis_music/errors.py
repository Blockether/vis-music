"""The one error vis-music raises for a fault of the track or the engine."""


class MusicError(RuntimeError):
    """The track does not compile, a layer is unknown, or the engine failed."""
