# Room measurement (ADR 0044, A6.22)

Measured on 11 October 2026 with `pnpm measure:room` ([measure-room.ts](../../../tests/e2e/src/measure-room.ts) and the files beside it in `tests/e2e/src/measure-room/`). Every figure here is in [room-measure.raw.json](room-measure.raw.json), and the frame repeats are in [room-frames.raw.json](room-frames.raw.json). The run settles ADR 0044's provisional defaults (decision 1) and the watchers' share of a page's calls (decision 12).

## Machine and method

The machine is a 4-CPU Intel Xeon at 2.80 GHz with 15.7 GiB, Linux 6.18.44 in a Firecracker VM, and Node 22.22.0. The relay is `main.ts` as the image starts it, under the Dockerfile's `--max-old-space-size=192`, with `--expose-gc` and a probe loaded by `--import` that reports the event loop's delay, the heap and CPU time over IPC and changes nothing else. It runs in cgroup v1 groups, as decision 31 asks: 512 MiB of memory, with swap capped at the same, and a CPU quota per 80 ms period of 80 ms (one whole CPU, a shared-cpu-1x machine's burst) or 5 ms (Fly's 6.25% baseline). `taskset` pins it to CPU 3 and the harness to CPUs 0 to 2.

The relay is in hosted mode: production, a public URL, the stand-in provider as issuer, `Fly-Client-IP` set by a stand-in edge trusted at 127.0.0.1/32, invites on and an audit directory, every other setting at its default. The class of 80 also sets 80 watching seats and an invitee pool of 200, since the defaults are sized for 40.

The page is the sim page running the real adapter core with the map profile, plus a read-only `read_notes` whose 119,500 characters leave the relay as six JSON bytes each (717,262 bytes an answer), with `capture_view` answering a noise PNG just under the 64 KiB cap (86,436 bytes), and it publishes about 4 KiB of state twice a second. The teacher, a member on 2026-07-28, pairs as driver, calls `set_view` every 2 s throughout and starts a four-hour session with the class's watching seats and proposals from everyone. Each student taps within 30 s of the first, adds the connector (a stranger's session), signs in once at `/i` from an address of its own, and taps Join again 10 s after a refusal; once in, it holds a second 2025-11-25 session and a 2026-07-28 client with a listen stream.

Then come the phases. In class (5 minutes) each chat reads state every 20 s, the view every minute, captures every 2 minutes and proposes a stop every 3, one call at a time and then waiting on its proposal; the second device reads state every minute, and the teacher accepts the oldest proposal every 20 s and dismisses the rest. In agents (2 minutes, then 2 more at the baseline) every student's agent loops `wait_for_page_state` at its 60-a-minute budget. In stalled a quarter of the class leaves a notes answer and an image unread, and in ceiling every student reads two notes answers slowly, taking at most 64 KiB every 25 s. On this loopback the kernel took a whole unread answer from the relay, so those two phases cap TCP buffers at 64 KiB a direction, as an edge that buffers little would, and put them back after (`docs/notes/verified.md`).

## Against the bars

The bars are the design's: peak RSS at most 400 MB, the heap after a collection at most 150 MiB, the event loop's p99 at most 50 ms and the teacher's p95 at most 250 ms at the burst quota, no guest 503 and no member cut. Both classes passed every one.

| Figure, worst phase                        | 40, defaults | 80, wider seats | Bar       |
| ------------------------------------------ | ------------ | --------------- | --------- |
| Peak RSS (VmHWM)                           | 230.5 MiB    | 269.6 MiB       | 381.5 MiB |
| Peak in the memory group                   | 180.1 MiB    | 220.6 MiB       | 512 MiB   |
| Heap after a collection                    | 36.1 MiB     | 41.9 MiB        | 150 MiB   |
| Event loop p99, burst quota                | 17.6 ms      | 20.0 ms         | 50 ms     |
| Teacher's `set_view` p95, burst quota      | 55.3 ms      | 123.2 ms        | 250 ms    |
| Guest 503s, member cuts, OOM kills         | 0, 0, 0      | 0, 0, 0         | none      |
| CPU, chat class and agent room, of one CPU | 5.2%, 19.4%  | 7.5%, 29.9%     | not a bar |
| Largest roster frame                       | 14,139 B     | 26,693 B        | 768 KiB   |

The peaks come from the ceiling phase, the class alone holding 164.4 MiB (40) and 169.3 MiB (80). The default pool served 40 students' 80 sessions, each student opening its first as a stranger before joining, with no 503.

## Joining

| Class                      | All in | First minute | Refused at `/i`                |
| -------------------------- | ------ | ------------ | ------------------------------ |
| 40, addresses of their own | 85 s   | 29           | 60 Joins, `rate_limited`       |
| 80, addresses of their own | 142 s  | 29           | 311 Joins, 80 sign-ins         |
| 40 behind one address      | 190 s  | 10           | 321 sign-ins, from one address |

The page takes 30 pairings a minute, the teacher's own among them (S14), so the 30th student onward waited for the minute to turn. The relay takes 60 sign-ins a minute in all, and on a hosted relay 10 from one address (ADR 0018), and that per-address share, not the page's, is what a class behind one campus network meets: 10 a minute.

## CPU and the baseline

An agent room at its budget cost the relay 5.3 ms of CPU a request at 40 (36 waits a second) and 4.1 ms at 80. At Fly's 6.25% baseline the relay fell behind: the event loop's p99 reached 3.5 s at 40 and 6.1 s at 80, the teacher's calls took 4.3 s at the median at 40, and at 80 two of them and 54 waits passed the client's 60 s, the relay logging an adapter error for three that gave up. A chat class of 40 needs about 5% of a CPU, under the baseline; an agent room needs a fifth to a third of one.

## Unread answers

With a quarter of each class leaving answers unread, the stall rule cut the notes answers after 30 to 40 s (10 at 40, 9 at 80) while the images, small enough for the narrowed buffers, went. Reading slowly, the class of 80 left at most 93.0 MiB of answers in the relay, just under the 96 MiB ceiling, at 269.6 MiB of RSS; the stall rule cut 21 readers whose windows stayed shut for 30 s. One page's class cannot ask much faster, since the watchers' share spaces its calls, so the ceiling bounds several pages at once. An earlier run that day, with the share at 120 a minute and readers taking 16 KiB every 4 s, did pass it: 26 guests' answers were cut, none of the teacher's, at 104.8 MiB of answer buffers and 296.1 MiB of RSS, the loop's p99 at 23.7 ms.

## The projected tab

The share exists so a room cannot make the teacher's projected tab stutter, so the run times the canvas map page (`tests/map-page`) in headless Chromium 141 while a member calls it at a fixed rate, 40 s a rate, on a relay in the harness with the budgets raised out of the way. A frame is late past 33 ms, two frames at 60 Hz, of about 2,400 a rate. The final run's figures are in the main file, and four repeats after it in the frames file:

| Calls to the page  | Late frames, final run and repeats | 99th percentile frame                   |
| ------------------ | ---------------------------------- | --------------------------------------- |
| none               | 1, 2, 2, 2, 2                      | 16.8 ms in all                          |
| `capture_view` 1/s | 19, 21, 18, 23, 11                 | 16.8 ms in all                          |
| `capture_view` 2/s | 18, 38, 41, 31, 35                 | 16.8 ms in the final run, else 33.3 ms  |
| `capture_view` 4/s | 24, 53, 39, 26, 30                 | 33.2 to 33.4 ms                         |
| `get_view` 1/s     | 5, 8, 6, 12, 8                     | 16.8 ms in all                          |
| `get_view` 2/s     | 3, 7, 9, 8, 5                      | 16.8 ms in all                          |
| `get_view` 20/s    | 139, 255, 228, 241, 322            | 33.4 ms in the final run, 50 to 66.6 ms |

Four runs earlier that day (the first 20 s a rate, the rest 40 s), whose raw files the final one replaced, agree: at one `capture_view` a second the p99 held at one frame every time, and at two it was 33.3 to 49.9 ms in all four, as was `get_view` at two a second in two of them. So the watchers' share is one call a second per page, 60 a minute: what the tab bears from the image call the share exists for, in every run.

## What it settles

**Watching seats, 40:** kept; both classes passed, so 40 leaves room. **Invitee pool, 100:** kept; 40 students hold 80 sessions, and with a fifth more for a join rush that is 96. **Requests per invitee, 60 a minute:** kept, as decision 11 says; it fits at the burst quota, and the baseline is a question of machine size (the owner's checklist). **Response ceiling, 96 MiB:** kept; 400 MB less the class's 164.4 MiB, less a quarter, leaves 162.8 MiB, and the relay held 93 to 105 MiB of answers well inside the group. **Watchers' share:** lowered from 120 to 60 calls a minute per page, as above. **Joining:** no limit changes; page 15 tells a teacher to hand the link out a few minutes early.

## What it leaves out

It ran on one sandbox, not Fly's hardware: Fly's burst balance, its proxy's buffering and its network are not modelled, the frame figures come from headless Chromium with software rendering, and the harness shared the machine, its own loop's p99 under 28 ms. It ran one page at the plan's two sizes, not the design's 60 and 100 or two pages of 40, and the unread phases depend on the narrowed buffers. Choosing the reference deployment's machine size is the owner's, from these figures.
