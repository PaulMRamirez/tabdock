# Room measurement (ADR 0044, A6.22)

Measured on 11 October 2026 with `pnpm measure:room` ([measure-room.ts](../../../tests/e2e/src/measure-room.ts) and the files beside it in `tests/e2e/src/measure-room/`), at commit `db9a115` with nothing uncommitted. Every figure on this page is in [room-measure.raw.json](room-measure.raw.json), whose `machine` block names the commit, the relay's default limits and rates as that commit ships them, and how the run was confined. Every room ran in hosted mode, which replaces three of those limits with `HOSTED_LIMITS` (100 page sessions relay-wide, 5 page sockets and 5 page sessions an address; ADR 0018); this run's file records only the defaults beneath them, a later run records both, and `room-measure-record.test.ts` holds the hosted three to a copy taken at `db9a115`, so a change to either fails until the run is made again. [room-measure.first.raw.json](room-measure.first.raw.json) is the full run before it, at `1ce301c`, kept for one frame figure below; it passed every bar too, but its cuts by rule were read before their minute was out and are low. Runs before the review of 11 October were not kept and nothing here rests on them. The measurement settles ADR 0044's provisional defaults (decision 1) and the watchers' share of a page's calls (decision 12).

## Machine and method

The machine is a 4-CPU Intel Xeon at 2.80 GHz with 15.7 GiB, Linux 6.18.44 in a Firecracker VM, and Node 22.22.0. The run starts itself again in a network namespace of its own (`unshare --net`), so nothing it sets reaches the host. The relay is `main.ts` as the image starts it, under the Dockerfile's `--max-old-space-size=192`, with `--expose-gc` and a probe loaded by `--import` that reports the event loop's delay past its 10 ms sampling interval, the heap, CPU time and what answers waiting to be read hold as the response ceiling counts them (`ResponseStalls.heldBytes`, sampled every 2 s), and changes nothing the relay does. It runs in cgroup v1 groups, as decision 31 asks: 512 MiB of memory with swap capped at the same, and a CPU quota per 80 ms period of 80 ms (one whole CPU, a shared-cpu-1x machine's burst) or 5 ms (Fly's 6.25% baseline). `taskset` pins it to CPU 3 and the harness to CPUs 0 to 2.

The relay is in hosted mode: production, a public URL, the stand-in provider as issuer, `Fly-Client-IP` set by a stand-in edge trusted at 127.0.0.1/32, invites on and an audit directory, every other setting at its default. Three rooms ran: a class of 40 on the defaults; a class of 80, with 80 watching seats and an invitee pool of 200; and two classes of 40 at once on two pages, with a pool of 200.

Each page is the sim page running the real adapter core with the map profile, plus a read-only `read_notes` whose 119,500 characters leave the relay as six JSON bytes each (717,262 bytes an answer), with `capture_view` answering a noise PNG just under the 64 KiB cap (86,436 bytes), and it publishes about 4 KiB of state twice a second. Its teacher, a member on 2026-07-28, pairs as driver, calls `set_view` every 2 s throughout and starts a four-hour session with the class's watching seats and proposals from everyone. Each student taps within 30 s of their class's first, adds the connector (a stranger's session), signs in once at `/i` from an address of its own, and taps Join again 10 s after a refusal; once in, it holds a second 2025-11-25 session and a 2026-07-28 client with a listen stream.

Then come the phases. In class (5 minutes) each chat reads state every 20 s, the view every minute, captures every 2 minutes and proposes a stop every 3, one call at a time and then waiting on its proposal; the second device reads state every minute, and each teacher accepts the oldest proposal every 20 s and dismisses the rest. In agents (2 minutes) every student's agent loops `wait_for_page_state` at its 60-a-minute budget. Both then run again for 2 minutes at the baseline. In stalled a quarter of each class leaves a notes answer and an image unread; in ceiling every student reads two notes answers slowly, taking at most 64 KiB every 25 s, while each teacher keeps two notes answers of their own waiting, read 64 KiB every 5 s so that the relay's checks always see progress and only the ceiling could take them. At each phase's end every unread answer is drained: whole if the rest arrives, cut if its connection ends first, and these counts match the relay's own cut lines in every phase. The heap is read after a collection taken while the load still runs, and a phase's log lines once the wall-clock minute it ended in is over, since the relay writes a repeated line's count then. On loopback the kernel takes a whole unread answer from the relay, so the two unread phases cap TCP buffers at 64 KiB a direction inside the namespace, as an edge that buffers little would (`docs/notes/verified.md`).

## Against the bars

The bars are the design's: peak RSS at most 400 MB, the heap after a collection at most 150 MiB, the event loop's p99 at most 50 ms and the teacher's p95 at most 250 ms at the burst quota, no guest 503, and no member cut, judged by every answer the teachers left waiting ending whole, which a run that left none fails. All three rooms passed every one.

| Figure, worst phase                              | 40, defaults | 80, wider seats | 2 × 40, pool 200 | Bar             |
| ------------------------------------------------ | ------------ | --------------- | ---------------- | --------------- |
| Peak RSS (VmHWM)                                 | 248.0 MiB    | 280.3 MiB       | 293.9 MiB        | 381.5 MiB       |
| Peak in the memory group                         | 197.7 MiB    | 231.2 MiB       | 245.1 MiB        | 512 MiB         |
| Heap after a collection under load               | 36.8 MiB     | 43.5 MiB        | 43.6 MiB         | 150 MiB         |
| Heap in use, peak of the samples                 | 45.7 MiB     | 53.6 MiB        | 53.2 MiB         | not a bar       |
| Event loop p99, burst quota                      | 8.7 ms       | 10.1 ms         | 11.7 ms          | 50 ms           |
| Teacher's `set_view` p95, burst quota            | 32.7 ms      | 57.4 ms         | 98.7 ms          | 250 ms          |
| Guest 503s, OOM kills                            | 0, 0         | 0, 0            | 0, 0             | none            |
| Teachers' answers left waiting, and cut          | 6, 0         | 8, 0            | 12, 0            | none cut        |
| Answers waiting as the ceiling counts them, peak | 60.5 MiB     | 84.7 MiB        | 95.5 MiB         | ceiling: 96 MiB |
| Cut by the ceiling, by the stall rule            | 0, 31        | 0, 54           | 28, 66           | not a bar       |
| CPU, chat class and agent room, of one CPU       | 4.6%, 17.7%  | 7.2%, 30.7%     | 7.5%, 27.7%      | not a bar       |
| Largest roster frame                             | 14,181 B     | 27,710 B        | 14,191 B         | 768 KiB         |

The memory peaks come from the ceiling phase. One class, however large, left at most 60.5 or 84.7 MiB waiting, since the watchers' share spaces a page's asks; two classes at once, each page with its own share, reached the 96 MiB ceiling, which cut 28 guests' answers while every one of the 12 answers their teachers kept waiting ended whole. In stalled the stall rule cut every notes answer the relay gave out unread, while the images, small enough for the narrowed buffers, went (at 80 the page's share refused 23 of the 40 asks); the rest of its cuts were slow readers in ceiling whose window stayed shut for 30 s. The default pool served 40 students' 80 sessions, each student opening its first as a stranger before joining, with no 503.

## Joining

| Class                      | All in | First minute | Refused on the way                          |
| -------------------------- | ------ | ------------ | ------------------------------------------- |
| 40, addresses of their own | 85 s   | 29           | 60 Joins: 39 by the invite, 21 by the page  |
| 80, addresses of their own | 142 s  | 29           | 311 Joins (225, 86) and 80 sign-ins at `/i` |
| 2 × 40 on two pages        | 69 s   | 58           | 8 Joins by a page and 80 sign-ins at `/i`   |
| 40 behind one address      | 190 s  | 10           | 321 sign-ins from one address               |

A page takes 30 pairings a minute, the teacher's own among them (S14), and an invite 30 redemptions a minute (ADR 0017), and a Join the page refuses still spends its invite's. Students tapping again every 10 s therefore met the invite's limit more often than the page's: of a class of 40's 60 refused Joins, 39 were the invite's. `/i` signs in 60 people a minute in all and, on a hosted relay, 10 from one address (ADR 0018), and that per-address share is what a class behind one campus network meets.

## CPU and the baseline

At the burst quota an agent room cost the relay 4.8 ms of CPU a request at 40 (36 waits a second) and 4.2 ms at 80. At Fly's 6.25% baseline a chat class of 40 used 5.3% of one CPU, most of the quota, its loop's p99 at 0.55 s and the teacher's `set_view` at 0.57 s at the median and 3.4 s at p95. A chat class of 80, or two of 40, used it all (6.1 to 6.2%): the loop's p99 reached 3.8 to 4.2 s, the teacher's p95 10.1 to 10.6 s, and 58 to 88 state reads passed the client's 60 s. An agent room at the baseline fell further behind, the loop's p99 at 5.1 to 5.7 s: with 40 the teacher's `set_view` took 3.4 s at the median, with 80 two of the teacher's three calls passed 60 s, and in the larger rooms 68 to 82 waits did. At the baseline the relay also logged its argument check worker starting late, and calls going to the page unchecked meanwhile, as ADR 0010 allows. So the baseline carries a chat class of 40 slowly and nothing larger; at the burst quota a chat class took 4.6 to 7.5% of a CPU and an agent room 17.7 to 30.7%.

## The projected tab

The share exists so a room cannot make the teacher's projected tab stutter, so the run times the canvas map page (`tests/map-page`) in headless Chromium 141.0.7390.37 while a member calls it at a fixed rate, 40 s a rate, on a relay in the harness with the budgets raised out of the way, five times over. A frame is late past 33 ms, two frames at 60 Hz, of about 2,400 a rate.

| Calls to the page    | Late frames, five runs  | 99th percentile frame |
| -------------------- | ----------------------- | --------------------- |
| none                 | 0, 0, 2, 1, 4           | 16.8 ms in all        |
| `capture_view` 0.5/s | 4, 2, 1, 3, 1           | 16.8 ms in all        |
| `capture_view` 1/s   | 15, 7, 7, 13, 14        | 16.8 ms in all        |
| `capture_view` 2/s   | 47, 34, 42, 35, 31      | 33.3 ms in all        |
| `capture_view` 4/s   | 27, 29, 45, 26, 45      | 33.3 ms in all        |
| `get_view` 1/s       | 5, 6, 1, 1, 4           | 16.8 ms in all        |
| `get_view` 2/s       | 10, 3, 10, 8, 0         | 16.8 ms in all        |
| `get_view` 4/s       | 5, 5, 4, 9, 9           | 16.8 ms in all        |
| `get_view` 20/s      | 321, 162, 204, 239, 268 | 33.4 to 66.6 ms       |

At one `capture_view` a second 0.3 to 0.6% of frames were late, under the 1% at which the 99th percentile becomes two frames; at two a second 1.3 to 2.0% were. The first run, kept, saw 25 late of 2,427 at one a second (1.0%) and its 99th percentile at 33.2 ms, so one a second sits near that edge rather than far below it. The watchers' share is one call a second per page, 60 a minute, the most the tab bore from the image call the share exists for in all five runs here; a lower share is an option the code takes, not a setting.

## What it settles

**Watching seats, 40:** kept; every room passed. **Invitee pool, 100:** kept for one class of 40 at a time: 40 students hold 80 sessions, and a fifth more is 96. A relay that hosts several classes at once sets `TABDOCK_MAX_INVITEE_SESSIONS` to about 96 for each class of 40, as the two classes ran on 200. **Requests per invitee, 60 a minute:** kept, as decision 11 says; it fits at the burst quota, and the baseline is a question of machine size. **Response ceiling, 96 MiB:** kept; the design's rule, the RSS left after the chat class less a quarter, gives 157 MiB for one class of 40 and 152 MiB for two, and with the ceiling cutting, RSS peaked at 293.9 MiB. **Watchers' share:** 60 calls a minute per page, and 15 for each watcher, so no fewer than four can spend it (ADR 0044's notes). **Joining:** no limit changes; page 15 tells a teacher to hand the link out a few minutes early, and anyone refused as too soon to wait a minute rather than tap again.

## What it leaves out

It ran on one sandbox, not Fly's hardware: Fly's burst balance, its proxy's buffering and its network are not modelled, the frame figures come from headless Chromium with software rendering, and the harness shared the machine, its own loop's p99 at most 31.7 ms. It ran 40, 80 and two pages of 40, not the design's 60 and 100, each class phase for 5 minutes and each baseline phase for 2, and the unread phases depend on the narrowed buffers. Choosing the reference deployment's machine size is the owner's, from these figures.
