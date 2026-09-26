---
title: "The Missing Cores: A 24-core machine is idle inside polars?!"
dek: "This is part one of a season spent profiling the popular DataFrame library polars. It covers a regex that leaves 23 of 24 threads stuck in line for a lock, window functions that run for a staggering forty seconds on one core, and a benchmark accident that invented a finding out of thin air."
date: 2026-09-25
image: og-missing-cores-part-1.png
---

To give you a real sense of what each of these findings costs, we will run every one of them through three clocks.

<aside class="clocks">
<dl>
<dt>Wall clock</dt>
<dd>What the end user waits for. This is the physical wall time.</dd>
<dt>Machine clock</dt>
<dd>Because computers are too fast to feel, we will slow one down: one cycle will equal one second. So to map this to the real world, an L1 cache hit is a heartbeat. Fetching data from main memory is a coffee break. And as we're about to see, a four-row calculation that should take a blink will take about half an hour.</dd>
<dt>Design clock</dt>
<dd>Why the source code looks the way it does.</dd>
</dl>
<p>It should go without saying, but every claim and finding in this writeup was measured on the exact setup and test machine listed below.</p>
</aside>

It is easy to assume that a heavily optimized open source project, especially one as fast as polars, has been profiled to death. But the truth is, high performance software is often where the most subtle inefficiencies take residence. To understand exactly where these inefficiencies lived, we first need to look at the skeleton of polars. You don't need to be a core maintainer or developer of polars. If you roughly know what a thread is and what a hash table does, you'll be alright.

## The skeleton of polars

polars is a DataFrame library. Think of pandas, rebuilt from the ground up in Rust with one obsession: using every single core your machine has. You describe a query in Python, Rust or SQL, polars turns it into a plan, and then it executes that plan in parallel over data stored column by column. Very often that data comes straight out of **Parquet** files, the compressed, columnar file format that has become the standard of the data world.

Under the hood, polars actually has two execution engines. The older **in-memory engine** loads what it needs and works on it as a whole. The newer **streaming engine** pushes data through in batches. We'll point out which one we're in whenever the difference matters.

**The workload.** To put polars under real pressure, we used **TPC-H**, the industry's standard analytics benchmark. It models a made-up wholesaler with customers, orders, and the individual line items on each order. At scale factor 30, the `lineitem` table alone holds **180 million rows**, and `orders` holds 45 million. Queries numbered 1 to 22 are TPC-H's own. Anything numbered higher is a probe we wrote specifically to reach code paths TPC-H never touches.

**The test machine.** An Intel Xeon Gold 5412U with 24 cores and 48 hardware threads, with turbo boost switched off so the clock speed never wanders. One wrinkle worth knowing up front: the machine ran with **4 memory channels** for the first half of the season and **8** for the second. More channels means more memory bandwidth, and that alone moved several baselines. Wherever it matters, the table tells you which one you're looking at.

**How to read the tables.** Every before-and-after comparison is a *paired A/B*: the unchanged build ("stock") and the modified build ("patched") run alternately, round after round, so both see exactly the same machine conditions. Each result carries three numbers:

- **"6/6"** means the patched build won all six rounds.
- **t** is a t-statistic. Anything beyond roughly ±3 is far outside noise. A t of -64 is not a coincidence.
- **CI** is the 95% confidence interval for the change. If it doesn't cross zero, the effect is real.

On top of that, every experiment includes **control queries**: queries the change cannot possibly affect. If a control moves, the measurement is broken, not the code.

## One owner, twenty-three borrowers

<span class="clock">Wall clock</span> Let's start with a single question, asked of 180 million shipping comments:

```sql
select count(*) from lineitem where l_comment like '%special%'
```

On one thread, the answer takes 20.6 seconds. On twenty-four threads, it takes 2.76.

That's **7.5x faster from 24 times the cores**. Roughly seventy percent of the machine is simply missing.

To see where it went, you need one piece of background. polars doesn't read all 180 million comments and *then* filter them. It pushes the filter down into the Parquet reader, which tests each value the moment it's decoded and throws the losers away on the spot. This is called **predicate pushdown**, and it's a genuinely good idea. The filter in this case is a regular expression, because SQL's `LIKE` gets translated into one.

A regex engine needs scratch memory while it scans, to keep track of where it is inside the pattern. Allocating fresh scratch memory for every one of 180 million matches would be painfully slow, so the regex library keeps a **pool** of scratch buffers and lends them out.

<span class="clock">Machine clock</span> Now follow a single row. On one thread, deciding whether one comment contains `special` costs about **4 minutes** of dilated time, and about 2 of those minutes are the actual search.

Give the same query 24 threads and follow the same row again. The search still costs about **2 minutes**. It always did. But the row now costs about **13 minutes** of thread time, and roughly **6 of them** are spent standing in a queue, waiting to borrow a scratch buffer.

*(Derived from the measurements: total thread time divided by 180M rows, converted to cycles, and split by where the profiler says the time went. It assumes every thread was busy the whole run, so treat it as an upper bound.)*

| threads | cycles per row | searching | borrowing the buffer |
|---|---|---|---|
| 1 | ~241 | ~127 | ~0 |
| 4 | ~484 | ~153 | ~158 |
| 24 | ~772 | ~139 | **~372** |

![](/figures/fig1-regex-cycles-per-row.svg)

Read the searching column from top to bottom: 127, 153, 139. The real work never grew. Everything stacked on top of it is threads getting in each other's way.

<span class="clock">Design clock</span> Here's the thing though: the pool is actually smart. It keeps exactly one slot that needs no locking at all, reserved for whichever thread used the regex first. Every other thread has to go through a **mutex**, a lock that only one thread can hold at a time. For one regex used by one thread, that is exactly the right design, because the common case is free.

The problem is that polars compiles **one** regex and hands that same object to **every** thread decoding the file. One thread gets the free lane. The other twenty-three take the lock, once per value, across 180 million values.

How can we be sure that's what's happening? The profiler practically confesses. The hottest function is `Pool::put_value`, the code that *returns* a borrowed buffer, and it only ever runs when the returning thread isn't the owner. If every thread had its own regex, that function wouldn't show up at all.

**The fix** gives each thread its own copy of the regex, through a per-thread regex cache polars already had elsewhere. A polars maintainer, orlp, suggested that route in code review, and it rests on a detail nobody had actually checked. When you copy a regex in this library, the copy gets a **brand-new** pool, owned by whichever thread uses it first. Had copying shared the original pool instead, his suggestion would have silently done nothing while looking perfectly clean in review. It doesn't. That's a library designed well all the way down.

| 8-channel machine | before | after | change |
|---|---|---|---|
| `like '%special%'` | 2544.0 ms | **1085.9 ms** | **-57.23%**, t=-64.33, 6/6 |
| `like 'the%'` | 1835.3 ms | **677.8 ms** | **-62.85%**, 6/6 |
| control, no regex | 237.4 ms | 235.4 ms | -0.86%, noise |

Scaling jumped from **8.6x to 20.4x**, while the single-thread time barely moved. That second number is the one we trust most. The owning thread always had the free lane, so a correct fix *has* to change nothing at one thread and a lot at 24. That is exactly what it did.

One more thing. The pull request itself claimed **-61.5%**. That number came from the 4-channel machine, and it was correct there. On 8 channels it **does not reproduce**, at any thread count we tried. The fixed build performed the same on both machines. The entire gap was in the *unfixed* build: extra memory bandwidth makes the lock-bound version faster without making the fix any weaker.

Same patch, two machines, two correct numbers.

## Instruments for the invisible

Before going any further, it's worth stepping back, because none of these findings came from staring at a profiler.

A **profiler** samples the CPU thousands of times a second and records which function was running. It's the standard tool, and it's excellent at exactly one thing: telling you where *busy* cores spend their time.

The regex bug was found differently. We changed **one variable**, the thread count, and watched how the profile *moved*. At one thread, zero time in the pool. At four, a third of it. At twenty-four, half. The real work per row stays flat while the coordination cost climbs with every thread you add. No single profile can show you that. Only the comparison can.

Running that same sweep across 45 queries led us to a second instrument. Linux's `perf stat` reports how many **CPUs were actually utilized** on average, and that one number splits bad scaling into two failures that look identical on a stopwatch:

- **Busy cores, bad scaling.** The cores are working, but on wasted effort: fighting over locks and shared data. That's the regex pool.
- **Idle cores, bad scaling.** The work simply isn't there to do. And here's the catch: **a profile of this looks completely clean**, because a core sitting idle never shows up as a function.

So how do you see time that leaves no trace in the profile?

Enter **phase timing**. Chop the run into one-second buckets and count how many cores were busy in each one. It turned out to be the instrument of the entire season. On a 24-core machine, one thread grinding away alone for forty seconds is only a *tiny* fraction of the total samples. One query's profile looked flat and utterly boring, with its top function at a mere 4%. The phase timeline for that very same query showed **exactly one core busy, from second 6 to second 47.**

The profile averaged the problem away. The timeline caught it red-handed.

### The twist: the benchmark was lying about memory allocation

Halfway through the season, we had a villain, and a convincing one. Queries sorting by two columns to fetch a top-k (`ORDER BY a, b LIMIT k`) scaled at only 12x. We found the code responsible, and it really does skip an optimization that the one-column version gets. Mechanism, profile, estimate. Case closed.

Or was it?

Phase timing on another query showed 23 cores sitting and waiting while a single thread returned memory to the operating system. Why on earth would *cleanup* be single-threaded? The answer turned out to be one missing line in our own benchmark harness. Every program runs on a **memory allocator**, the code behind every `malloc` and `free`. Our harness used the system default, glibc's. polars ships with a different one, **jemalloc**, which is built specifically for heavily multi-threaded programs.

| same code, allocator swapped | glibc scaling | jemalloc scaling |
|---|---|---|
| two-key top-k | 12.06x | **20.47x** |
| another two-key top-k | 15.70x | **20.19x** |
| TPC-H q18 | 16.23x | **19.82x** |
| a join (didn't care either way) | 21.58x | 21.82x |

![](/figures/fig4-allocator-scaling.svg)

**The finding flipped completely.** With the right allocator, two-key top-k scaled *better* than one-key. The bottleneck had been the allocator all along, not the missing optimization. That piece of code is still there to look at, but it has no measured cost, so we withdrew the performance claim.

Everything else about that harness was right. The machine was quiet, the clock speed was stable, the statistics were sound, and the results were correct on every single run. And one missing line still managed to invent a finding out of thin air, complete with a convincing mechanism and a supporting profile.

A benchmark that doesn't use the project's own allocator isn't benchmarking the project. It's benchmarking itself.

### An aside: the very first query crashed

Funnily enough, the very first probe query we wrote didn't find a slowdown at all:

```text
thread 'main' panicked at crates/polars-stream/src/nodes/top_k.rs:488:24:
not implemented for dtype Int128
```

The query was simply "top 20 rows sorted by a price column." Prices are stored as **decimals**, and polars keeps decimals internally as 128-bit integers. The sorting code *does* have a case for 128-bit integers. But that case is switched on by a compile-time feature flag, and Rust evaluates this particular flag where the code is *used*, not where it's *written*. The streaming engine's build never turned the flag on. Five of polars' internal packages turn it on correctly. Four don't.

The fix is a single line in a build file. Python users never hit it, because the Python build enables the flag explicitly. Rust users could, with nothing more exotic than a Parquet file containing a decimal column.

Not what we were looking for, but absolutely worth finding.

## The one-core hours

**Window functions** are the SQL feature for "compute something about each row relative to its group." Number the items within each order. Look up the previous item's price. Keep a running total per customer. They're everywhere in analytics, which is exactly why what follows matters.

<span class="clock">Wall clock</span> Here are two queries over the same 45 million orders and the same 180 million rows, on the 4-channel machine. The only difference between them is an `order by` inside the window.

| query | what it computes | time | cores busy |
|---|---|---|---|
| sum per order | `sum() over (partition by l_orderkey)` | 2,617 ms | **23.06** |
| number rows within each order | `row_number() over (partition by l_orderkey order by ...)` | 50,492 ms | **2.29** |

Asking for the rows *in order* within each group costs a staggering **19x**, while nearly 22 cores sit around doing nothing.

And the polars authors are completely upfront about it. Here's the comment sitting right on top of that code path:

```rust file="crates/polars-expr/src/expressions/window.rs"
// ... we can now relatively efficient arg_sort per group. This
// is still horrendously slow, but at least not as bad as it would be if you
// did this naively.
```

Nobody missed this. It was written down, in plain English, waiting for someone to pick it up.

### Few big groups: a sort told to stay home

When there are millions of groups, polars spreads the *groups* across threads and sorts each one on a single thread. With millions of groups, that's exactly right: there's plenty of work to go around. The code even says so, `multithreaded: false`, right next to a comment noting that it's already running in parallel.

Now try **three** groups. Three threads each get one group, and each of them sorts 60 million rows alone.

That leaves twenty-one cores idle. By construction.

**Attempt 1:** let each group's sort use all the threads whenever there are fewer groups than threads. The three-group query got 47% faster. Then a sweep across different group counts turned up a **50**-group query running **23.7% slower**. That query should never have been touched, since 50 is not fewer than 24.

Stranger still, the slowdown came and went. The unmodified code varied by 1% between rounds. The patched code sometimes matched it and sometimes came in 11-18% slower. A plain slowdown doesn't flicker like that.

Here's the thing though: **the same sorting function was called from a second place we hadn't read.** That second caller sorts *sub*-groups from inside work that's already spread across every thread, where group counts are naturally small. So our new rule kicked in there too, and launched parallel sorts inside parallel work. Threads fighting threads.

**Attempt 2** lets the caller say whether the thread pool is actually free, and only the top-level caller says yes. The three-group query: **-48.1%, -48.3%, -48.1%** over three rounds. The fifty-group query: flat. (These sort measurements are from the 8-channel machine.)

A word on correctness here, because this one is subtle. The package's test suite reported success. It had run **zero tests**, because that package has no tests of its own. We recorded that as "not run," not as a pass. What actually proves correctness is an argument: both sorting routines are **stable**, meaning rows that tie keep their original order, and two stable sorts of the same data always produce the same result. Had either been unstable, row numbers for tied rows could differ between builds, and a simple row count would never have noticed.

### Many tiny groups: forty seconds at exactly one core

Now the other extreme: 45 million orders, about four rows each.

Our first write-up blamed a specific loop, based on **reading the code**. It was wrong. That loop only runs for a different kind of query. It's in the ledger at the end, where it belongs.

Phase timing found the real problem: from second 6 to second 47, **exactly one core busy.** A profile of just that window named the culprit: **74.67%** of the time sat inside a generic fallback routine, all of it on a single thread.

<span class="clock">Design clock</span> polars' SQL layer implements `row_number()` as "make a range from 0 to the group's length, then add 1." Range-building has no dedicated per-group implementation, so it falls back to a general-purpose path. That path walks every group one by one: package each input into a standalone column object (a **Series**, polars' heap-allocated column type), call the function, collect the result. As a fallback for rarely used functions, that's perfectly sensible. The problem is that `row_number()` is anything but rarely used.

<span class="clock">Machine clock</span> 45 million groups of about four rows, in roughly forty seconds on one core. That works out to about **half an hour** of dilated time per four-row group, mostly spent building and throwing away column objects around a four-number range.

**The fix** is a dedicated per-group version that builds every group's range into one output in a single pass, with the same results and the same error messages in the same order.

| 4-channel machine | before | after | change |
|---|---|---|---|
| row numbers, 45M groups | 50,716 ms | **13,111 ms** | **-74.15%**, 4/4 |
| row numbers, 6M groups | 14,885 ms | 8,587 ms | **-42.28%**, 6/6 |
| three controls | | | under 0.1%, noise |

![](/figures/fig2-row-number-timeline.svg)

We checked it three ways. A checksum over all 179,998,372 rows came out identical. A battery of 273 edge cases, run through both builds, produced identical output line for line, error messages included. And a profile confirmed the new code was actually running, with zero time left in the old path.

### LAG, LEAD, and the atomic nobody invited

`LAG(price)` means "the previous row's price, within this group." Sounds harmless, right? On 45 million groups it runs for **88.6 seconds, at 1.71 cores.** It's the same generic fallback as before.

<span class="clock">Machine clock</span> Eighty seconds of one core over forty-five million groups works out to about an hour of dilated time per four-row group. And inside that hour, 16.6% goes to converting the "how many rows back" number into the right type. The same number, forty-five million times over.

So the obvious question is: why fix one function when you could fix them all? Make the generic fallback loop run in parallel, and every function that relies on it speeds up at once. We built exactly that, and it halved the time.

Then it stopped dead at ten cores.

Here's the thing though: every group's input is a slice of *one* shared data buffer. Rust tracks who's using a shared buffer with a **reference count**, a counter that goes up when someone takes a slice and down when they let it go. Every slice is an increment. Every release is a decrement. One counter, twenty-four cores.

And this is where the hardware bites. Each core has its own cache, which works in 64-byte chunks called **cache lines**. When two cores write to the same cache line, the hardware has to shuttle that line back and forth between them. Only one core can hold it at a time, and every hand-off costs time.

| where the parallel version spent its time | share |
|---|---|
| releasing slices | 27.72% |
| creating slices | 26.66% |
| copying slices | 12.84% |

Two thirds of the parallel phase was one cache line bouncing between cores. It's the regex pool all over again, just in a new costume.

<span class="clock">Design clock</span> A shared reference count is exactly right for a buffer with a handful of users. It was never meant for 45 million short-lived slices across 24 cores. Nobody got this wrong. The workload simply outgrew the design.

So the fix isn't smarter parallelism. It's not creating 45 million column objects in the first place. Convert "how many rows back" once, then compute every group's shifted positions in a single pass: **89.2 seconds down to 19.4, or -78.22%.** And the output checks itself: LAG should leave exactly one empty value per order, and it does. This fix isn't upstream yet. It waits on a design question a maintainer raised about the row-numbering fix, since both hook in at the same place.

![](/figures/fig3-lag-timeline.svg)

Did it work? Every checksum said yes. Every hand-picked test said yes. A 410-case battery comparing both builds said no. In one unusual shape of query, the old code returned one value per group and ours returned a list. We fixed it, re-ran the battery, and both builds matched.

The code got simpler and the query got 4.6x faster, but only one of those needed a test battery to believe.

## The ledger, so far

Everything in this post that we confidently wrote down and later had to correct:

| we said | what was actually true |
|---|---|
| The regex slowdown was in polars' general string code | That code already gave each thread its own regex. The bug was only in the Parquet reader |
| The regex fix is -61.5% | On the 4-channel machine. On 8 channels, -54% to -58.5% |
| Two-key top-k wastes ~80&nbsp;ms | The allocator was the bottleneck. Withdrawn |
| TPC-H q18 hits the same top-k problem | Top-k is 0.21% of q18 |
| Two top-k queries made a controlled comparison | They read different columns |
| The row-numbering slowdown was a particular loop | That loop never runs for this query. We'd read code instead of profiling |
| One window query had ~1.5M groups | 6,000,000 |
| “Formatting check: clean” | The check had failed on a missing tool. We read the exit code of the wrong command |
| Two boundary queries “passed” | Both had crashed. The check compared two empty outputs and called them equal |

The last two belong together. **A missing tool looks exactly like a clean result.** Check that the tool actually ran, and treat empty output as a failure, not as agreement.

## What this part taught us

1. **Change one variable and watch what moves.** One measurement can't tell threads fighting from threads working.
2. **Profiles average; timelines slice.** A single-threaded phase disappears into the average and stands out in the timeline.
3. **Benchmark with the project's own allocator.** Otherwise you're benchmarking your harness.
4. **Profile before you blame.** Both of our wrong attributions here came from reading code and never checking it against a profile.
5. **Run the same cases through both versions and diff everything.** Checksums missed the LAG bug. The diff caught it.
6. **Every number comes with its machine.** -61.5% and -57%, same patch, both correct.

## Still open

- A join on a key with only **7 distinct values** uses about 6 of 24 cores, probably because the join splits work by key and can't split 7 values 24 ways. It needs a realistic test before anyone gets to claim it.
- A sum over **3 groups** runs *slower* than the same sum over 45 million. Not chased. Yet.
- After the fix, the row-numbering query still takes about 12.5 seconds, mostly on one or two cores: a serial sort, the new range builder itself, and mapping results back to rows. The range builder alone could be split across threads for about 1.4 seconds more.

## Receipts

- Giving each decode thread its own regex: [pola-rs/polars#29411](https://github.com/pola-rs/polars/pull/29411)
- Building every group's range in one pass: [pola-rs/polars#29537](https://github.com/pola-rs/polars/pull/29537)

---

None of this came from a clever algorithm. It came from finding where a core was waiting, or working for nothing, and asking why.

<span class="clock">Wall clock</span> One last time: someone types a query and waits.

Every table above is time handed back to them.

*Next in the series: **Twelve seconds at a time**, where a single core spends 17% of a query waiting on bytes it wrote a moment earlier, and three small patches that give most of it back.*