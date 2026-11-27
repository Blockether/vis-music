// doughbox: a small program that plays and renders the dough synth engine.
//
// Copyright (C) 2026 Blockether. License: AGPL-3.0-or-later.
// It includes dough.h from the dough-synth package by Felix Roos and the Strudel
// contributors (AGPL-3.0-or-later) and miniaudio (public domain or MIT-0).
//
// It reads one command per line on stdin and writes each answer as one line
// that starts with "@" on stdout:
//
//   ping                      -> @pong
//   load <file> <freq> <path> -> @load <file> ok <frames> | @load <file> fail
//   start                     -> @start ok <backend> | @start fail <why>
//   stop                      -> @stop ok
//   now                       -> @now <seconds>   (the clock of "time" values)
//   ev <message>              (no answer) play or schedule a dough message now
//   queue <message>           (no answer) keep a message for "render"
//   render <seconds> <path>   -> @render ok <frames> <peak> <rms> | @render fail <why>
//   quit                      -> @bye
//
// Live sound uses the wall clock: a message with /time/<t> plays at the Unix
// time t. A render starts at time 0, so queued times count from the start.

#define MINIAUDIO_IMPLEMENTATION
#define DOUGH_IMPLEMENTATION
#define DOUGH_MINIAUDIO 1
#include "dough.h"

#define SAMPLE_RATE 44100
#define MAX_VOICES 128
#define MAX_ORBITS 8
#define MAX_DELAY_SECONDS 2
#define MAX_PCM_FLOATS (48 * 1024 * 1024)
#define MAX_EVENTS 4096
#define MAX_FILES 4096
#define LINE_MAX_BYTES 4096

static ma_device box_device;
static ma_mutex box_lock;
static int box_playing = 0;
static int64_t box_frame = 0;
static double box_origin = 0;

static double box_wallclock(void)
{
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return tv.tv_sec + tv.tv_usec / 1000000.0;
}

// The audio thread is the only reader of the engine while it plays. Every
// other change to the engine holds box_lock.
static void box_callback(ma_device *device, void *out, const void *in, ma_uint32 frames)
{
  (void)device;
  (void)in;
  double audio_time = box_frame / (double)SAMPLE_RATE;
  double drift = box_wallclock() - box_origin - audio_time;
  if (fabs(drift) > 0.02)
    box_origin += drift; // the system slept or the clocks drifted
  ma_mutex_lock(&box_lock);
  dough_render((float *)out, (int)frames, box_origin + audio_time);
  ma_mutex_unlock(&box_lock);
  box_frame += frames;
}

static int box_start(void)
{
  if (box_playing)
    return 0;
  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.format = ma_format_f32;
  config.playback.channels = CHANNELS;
  config.sampleRate = SAMPLE_RATE;
  config.dataCallback = box_callback;
  if (ma_device_init(NULL, &config, &box_device) != MA_SUCCESS)
    return -1;
  if (box_device.pContext->backend == ma_backend_null)
  {
    // miniaudio falls back to a silent device when the machine has none.
    ma_device_uninit(&box_device);
    return -2;
  }
  box_frame = 0;
  box_origin = box_wallclock();
  if (ma_device_start(&box_device) != MA_SUCCESS)
  {
    ma_device_uninit(&box_device);
    return -1;
  }
  box_playing = 1;
  return 0;
}

static void box_stop(void)
{
  if (!box_playing)
    return;
  ma_device_uninit(&box_device);
  box_playing = 0;
}

static unsigned char *box_read_file(const char *path, size_t *size)
{
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
  fseek(file, 0, SEEK_END);
  long length = ftell(file);
  fseek(file, 0, SEEK_SET);
  unsigned char *bytes = length > 0 ? malloc((size_t)length) : NULL;
  if (bytes && fread(bytes, 1, (size_t)length, file) != (size_t)length)
  {
    free(bytes);
    bytes = NULL;
  }
  fclose(file);
  *size = bytes ? (size_t)length : 0;
  return bytes;
}

static void box_load(char *args)
{
  int file_index = -1;
  float freq = 0;
  int used = 0;
  if (sscanf(args, "%d %f %n", &file_index, &freq, &used) < 2 || used == 0)
  {
    printf("@load %d fail\n", file_index);
    return;
  }
  char *path = args + used;
  size_t size = 0;
  unsigned char *bytes = box_read_file(path, &size);
  if (!bytes)
  {
    printf("@load %d fail\n", file_index);
    return;
  }
  ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 0, SAMPLE_RATE);
  ma_uint64 frames = 0;
  void *pcm = NULL;
  ma_result decoded = ma_decode_memory(bytes, size, &config, &frames, &pcm);
  free(bytes);
  int status = PCM_FAIL;
  if (decoded == MA_SUCCESS && config.channels >= 1 && config.channels <= CHANNELS)
  {
    ma_mutex_lock(&box_lock);
    status = dough_register_pcm(file_index, pcm, (int)frames, (int)config.channels, freq);
    ma_mutex_unlock(&box_lock);
  }
  if (pcm)
    ma_free(pcm, NULL);
  if (status == 0)
    printf("@load %d ok %d\n", file_index, (int)frames);
  else
    printf("@load %d fail\n", file_index);
}

static Event *queued = NULL;
static int queued_count = 0;
static int queued_capacity = 0;

static void box_queue(const char *message)
{
  if (queued_count == queued_capacity)
  {
    int capacity = queued_capacity ? queued_capacity * 2 : 1024;
    Event *grown = realloc(queued, capacity * sizeof(Event));
    if (!grown)
      return;
    queued = grown;
    queued_capacity = capacity;
  }
  Event *e = &queued[queued_count];
  reset_event(e);
  parse_event(e, message);
  if (isnan(e->time))
    e->time = 0;
  queued_count++;
}

static int by_time(const void *a, const void *b)
{
  double ta = ((const Event *)a)->time, tb = ((const Event *)b)->time;
  return (ta > tb) - (ta < tb);
}

static void put_u32(FILE *f, uint32_t v)
{
  unsigned char b[4] = {v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255};
  fwrite(b, 1, 4, f);
}

static void put_u16(FILE *f, uint16_t v)
{
  unsigned char b[2] = {v & 255, (v >> 8) & 255};
  fwrite(b, 1, 2, f);
}

// Renders the queued messages from time 0 into a 16-bit stereo WAV file.
static void box_render(char *args)
{
  double seconds = 0;
  int used = 0;
  if (box_playing)
  {
    printf("@render fail live sound is playing\n");
    return;
  }
  if (sscanf(args, "%lf %n", &seconds, &used) < 1 || used == 0 || seconds <= 0)
  {
    printf("@render fail bad arguments\n");
    return;
  }
  FILE *out = fopen(args + used, "wb");
  if (!out)
  {
    printf("@render fail cannot write the file\n");
    return;
  }
  qsort(queued, queued_count, sizeof(Event), by_time);
  int64_t total = (int64_t)(seconds * SAMPLE_RATE);
  uint32_t data_bytes = (uint32_t)(total * CHANNELS * 2);
  fwrite("RIFF", 1, 4, out);
  put_u32(out, 36 + data_bytes);
  fwrite("WAVEfmt ", 1, 8, out);
  put_u32(out, 16);
  put_u16(out, 1);
  put_u16(out, CHANNELS);
  put_u32(out, SAMPLE_RATE);
  put_u32(out, SAMPLE_RATE * CHANNELS * 2);
  put_u16(out, CHANNELS * 2);
  put_u16(out, 16);
  fwrite("data", 1, 4, out);
  put_u32(out, data_bytes);

  float block[BLOCK_SIZE * CHANNELS];
  int16_t pcm[BLOCK_SIZE * CHANNELS];
  double peak = 0, energy = 0;
  int next = 0;
  for (int64_t frame = 0; frame < total; frame += BLOCK_SIZE)
  {
    int frames = (int)(total - frame < BLOCK_SIZE ? total - frame : BLOCK_SIZE);
    double start = frame / (double)SAMPLE_RATE;
    double end = (frame + frames) / (double)SAMPLE_RATE;
    // dough drops a message more than 10 ms late, so hand each one over
    // shortly before its block.
    while (next < queued_count && queued[next].time < end + 0.005)
      schedule_push(&schedule, &queued[next++]);
    dough_render(block, frames, start);
    for (int i = 0; i < frames * CHANNELS; i++)
    {
      float s = block[i];
      double a = fabs(s);
      if (a > peak)
        peak = a;
      energy += (double)s * s;
      pcm[i] = (int16_t)lrintf(s * 32767.0f);
    }
    fwrite(pcm, sizeof(int16_t), frames * CHANNELS, out);
  }
  int ok = !ferror(out);
  ok = (fclose(out) == 0) && ok;
  queued_count = 0;
  double rms = total > 0 ? sqrt(energy / (double)(total * CHANNELS)) : 0;
  if (ok)
    printf("@render ok %lld %.6f %.6f\n", (long long)total, peak, rms);
  else
    printf("@render fail cannot write the file\n");
}

static void box_evaluate(const char *message)
{
  ma_mutex_lock(&box_lock);
  dough_evaluate(message);
  ma_mutex_unlock(&box_lock);
}

int main(void)
{
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (ma_mutex_init(&box_lock) != MA_SUCCESS)
    return 1;
  dough_init(SAMPLE_RATE, MAX_VOICES, MAX_ORBITS, MAX_DELAY_SECONDS, MAX_PCM_FLOATS, MAX_EVENTS, MAX_FILES);
  static char line[LINE_MAX_BYTES];
  while (fgets(line, sizeof(line), stdin))
  {
    size_t n = strlen(line);
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
      line[--n] = '\0';
    if (strncmp(line, "ev ", 3) == 0)
      box_evaluate(line + 3);
    else if (strncmp(line, "queue ", 6) == 0)
      box_queue(line + 6);
    else if (strncmp(line, "load ", 5) == 0)
      box_load(line + 5);
    else if (strncmp(line, "render ", 7) == 0)
      box_render(line + 7);
    else if (strcmp(line, "start") == 0)
    {
      int started = box_start();
      if (started == 0)
        printf("@start ok %s\n", ma_get_backend_name(box_device.pContext->backend));
      else
        printf("@start fail %s\n", started == -2 ? "no-audio-device" : "cannot-open-device");
    }
    else if (strcmp(line, "stop") == 0)
    {
      box_stop();
      printf("@stop ok\n");
    }
    else if (strcmp(line, "now") == 0)
      printf("@now %.6f\n", box_playing ? box_origin + box_frame / (double)SAMPLE_RATE : box_wallclock());
    else if (strcmp(line, "ping") == 0)
      printf("@pong\n");
    else if (strcmp(line, "quit") == 0)
      break;
    else if (n > 0)
      printf("@error unknown command\n");
    fflush(stdout);
  }
  box_stop();
  printf("@bye\n");
  return 0;
}
