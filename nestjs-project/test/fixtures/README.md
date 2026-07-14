# Test fixtures

## `tiny.mp4`

A ~3.7 KB H.264/MP4 clip (128×72, 1 s, 10 fps) used by the video-processing
tests (ffprobe/ffmpeg integration and the full e2e upload flow). It is committed
because ffmpeg is absent from the API image.

Regenerate it — and the ffprobe fixture the unit test asserts against — inside
the video-worker container (the only image with ffmpeg):

```bash
docker compose exec -T video-worker ffmpeg -y \
  -f lavfi -i testsrc=duration=1:size=128x72:rate=10 -pix_fmt yuv420p \
  /home/node/app/test/fixtures/tiny.mp4

docker compose exec -T video-worker ffprobe -v error -print_format json \
  -show_format -show_streams /home/node/app/test/fixtures/tiny.mp4 \
  > src/worker/__fixtures__/ffprobe-tiny.output.json
```
