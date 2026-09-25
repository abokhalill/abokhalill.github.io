---
title: "The Missing Cores: where a 24-core machine goes idle inside polars"
dek: "Part one of a season spent profiling polars: a regex that makes 23 of 24 threads queue for a lock, window functions that run for forty seconds on one core, and the benchmark bug that invented a finding."
date: 2026-09-25
image: og-missing-cores-part-1.png
---

<aside class="clocks">
<p class="clocks__title">Three clocks run through everything below</p>
<dl>
<dt>Wall clock</dt>
<dd>What a person waits for.</dd>
<dt>Machine clock</dt>
<dd>Computers are too fast to feel, so I slow one down. The test machine runs at a fixed 2.1 billion cycles per second. Here, <strong>one cycle becomes one second</strong>. Reading from the CPU's closest cache is a heartbeat. Going out to main memory is a coffee break. You'll see a four-row calculation that should take a blink take half an hour.</dd>
<dt>Design clock</dt>
<dd>Why the code looks the way it does. Spoiler: every time, it was reasonable when written.</dd>
</dl>
<p>Every claim points at a measurement. Every number says which machine it came from. And the numbers I got wrong have their own section at the end. There are a lot of them.</p>
</aside>

One thing you and I can agree on: nobody's software is perfect everywhere. Not even the fast stuff. *Especially* not the fast stuff, because fast software is where the remaining slowness hides best.

I spent a season inside one of the fastest data tools around, looking for where it leaves performance on the table. This is the first of four posts about what I found. It covers the cores that sat idle and the cores that spent their time fighting each other. No insider knowledge required. If you know roughly what a thread is and what a hash table does, you have everything you need. I'll explain the rest as we go.

## What polars is, and what we're measuring

**polars** is a DataFrame library. Think pandas, rewritten in Rust to use every core your machine has. You describe a query, in Python, Rust or SQL. polars plans it, then runs it in parallel over data stored column by column, very often reading straight from **Parquet** files (the standard compressed, columnar file format of the data world).

polars actually has two execution engines. The older **in-memory engine** loads what it needs and works on it whole. The newer **streaming engine** pushes data through in batches. Where the difference matters below, I'll say so.

It's built by people who benchmark for a living, and its hot paths have been profiled many times by people who knew what they were looking for. If a 24-core machine was going to come back empty-handed, this was the place.

It didn't.

**The workload.** **TPC-H** is the industry's standard analytics benchmark: a made-up wholesaler with customers, orders, and the individual line items on each order. At scale factor 30, the `lineitem` table has **180 million rows** and `orders` has 45 million. Queries numbered 1 to 22 are TPC-H's own. Everything numbered higher is a probe I wrote to reach code paths TPC-H never touches.

**The machine.** An Intel Xeon Gold 5412U: 24 cores, 48 hardware threads, turbo boost off so the clock speed never wanders. One wrinkle: it ran with **4 memory channels** for the first half of the season and **8** for the second. More channels means more memory bandwidth, and that moved several baselines, so wherever it matters, the table says which one.

**How to read the tables.** Every before-and-after comparison is a *paired A/B*: the unchanged build ("stock") and the modified build ("patched") run alternately, round after round, so both see the same machine conditions. Three numbers come with each result:

- **"6/6"** means the patched build won all six rounds.
- **t** is a t-statistic. Anything beyond about ±3 is far outside noise; -64 is not a coincidence.
- **CI** is the 95% confidence interval for the change. If it doesn't cross zero, the effect is real.

And every experiment includes **control queries**: queries the change can't possibly affect. If a control moves, the measurement is broken, not the code.

## One owner, twenty-three borrowers

<span class="clock">Wall clock</span> One question, asked of 180 million shipping comments:

```sql
select count(*) from lineitem where l_comment like '%special%'
```

One thread: 20.6 seconds. Twenty-four threads: 2.76.

**7.5x faster. From 24 times the cores.** Seventy percent of the machine, missing.

Some background first. polars doesn't read all 180 million comments and *then* filter them. It pushes the filter down into the Parquet reader, which tests each value as it decodes it and throws away the losers immediately. That's called **predicate pushdown**, and it's a good idea. The filter here is a regular expression, because SQL's `LIKE` gets translated into a regex.

A regex engine needs scratch memory while it scans, to keep track of where it is in the pattern. Allocating fresh scratch memory for every one of 180 million matches would be slow. So the regex library keeps a **pool** of scratch buffers and lends them out.

<span class="clock">Machine clock</span> Follow one row. On a single thread, deciding whether one comment contains `special` costs about **4 minutes** of dilated time. About 2 of those are the actual search.

Now give the query 24 threads and follow the same row. The search still costs about **2 minutes**. It always did. But the row now costs about **13 minutes** of thread time, and roughly **6** of them are spent standing in a queue, waiting to borrow a scratch buffer.

*(Derived from the measurements: total thread time divided by 180M rows, converted to cycles, and split by where the profiler says time went. It assumes every thread was busy the whole run, so treat it as an upper bound.)*

| threads | cycles per row | searching | borrowing the buffer |
|---|---|---|---|
| 1 | ~241 | ~127 | ~0 |
| 4 | ~484 | ~153 | ~158 |
| 24 | ~772 | ~139 | **~372** |

Read the searching column top to bottom: 127, 153, 139. The real work never grew. Everything added on top is threads getting in each other's way.

<span class="clock">Design clock</span> The pool is smart. It keeps exactly one slot that requires no locking at all, reserved for whichever thread used the regex first. Every other thread goes through a **mutex**, a lock that only one thread can hold at a time. For one regex used by one thread, that's the right design: the common case is free.

Here's the thing though. polars compiles **one** regex and hands that same object to **every** thread decoding the file. One thread gets the free lane. Twenty-three take the lock. Once per value.

How do we know that's what's happening? The profiler tells us. The hottest function is `Pool::put_value`, the code that *returns* a borrowed buffer, and it only runs when the returning thread isn't the owner. If each thread had its own regex, that function would never show up. The profile is a confession.

**The fix** gives each thread its own copy, using a per-thread regex cache polars already had elsewhere. That route was suggested in code review by a polars maintainer (orlp), and it rests on a detail nobody had checked. Copying a regex in this library builds a **brand-new** pool, owned by whichever thread uses it first. If copying had shared the original pool instead, his suggestion would have silently done nothing, while looking perfectly clean in review. It doesn't. Well designed, all the way down.

| 8-channel machine | before | after | change |
|---|---|---|---|
| `like '%special%'` | 2544.0 ms | **1085.9 ms** | **-57.23%**, t=-64.33, 6/6 |
| `like 'the%'` | 1835.3 ms | **677.8 ms** | **-62.85%**, 6/6 |
| control, no regex | 237.4 ms | 235.4 ms | -0.86%, noise |

Scaling: **8.6x to 20.4x.** Single thread: barely moved. That second number is the one I trust most. The owning thread always had the free lane, so a correct fix *must* do nothing at one thread and a lot at 24. It did exactly that.

One more thing. The pull request itself claimed **-61.5%**. That number came from the 4-channel machine, and it was correct there. On 8 channels it **does not reproduce**, at any thread count I tried. The fixed version performed identically on both machines. The whole gap was in the *unfixed* version: extra memory bandwidth makes the lock-bound version faster without making the fix any weaker.

Same patch. Two machines. Two correct numbers.

## Instruments for the invisible

Before the findings, a step back, because none of them came from staring at a profiler.

A **profiler** samples the CPU thousands of times a second and records which function was running. It's the standard tool, and it's excellent at one thing: telling you where busy cores spend their time.

The regex bug was found differently: by changing **one variable**, the thread count, and watching how the profile *changed*. At one thread, zero time in the pool. At four, a third. At twenty-four, half. The real work per row stays flat while coordination cost climbs with every thread. No single profile shows that. The comparison does.

Running that sweep across 45 queries led to a second instrument. Linux's `perf stat` reports how many **CPUs were actually utilized** on average. That one number splits bad scaling into two failures that look identical on a stopwatch:

- **Busy cores, bad scaling.** Cores are working, but on wasted effort: fighting over locks and shared data. The regex pool.
- **Idle cores, bad scaling.** The work just isn't there to do. And **a profile of this looks clean**, because a core sitting idle never shows up as a function.

So how do you see time that leaves no trace in the profile?

Enter **phase timing**. Chop the run into one-second buckets and count how many cores were busy in each one. It became the instrument of the season. On a 24-core machine, one thread grinding alone for forty seconds is a *tiny* fraction of the total samples. One query's profile looked flat and boring, with the top function at 4%. The phase timeline for that same query: **exactly one core busy, from second 6 to second 47.**

The profile averaged the problem away. The timeline caught it.

### The twist: the benchmark was lying about memory allocation

Halfway through, I had a villain, and a good one. Queries sorting by two columns to get a top-k (`ORDER BY a, b LIMIT k`) scaled at only 12x. I found the code responsible, and it really does skip an optimization that the one-column version gets. Mechanism, profile, estimate. Case closed.

Or was it?

Phase timing on another query showed 23 cores waiting while one thread returned memory to the operating system. Why would *cleanup* be single-threaded? The answer was one missing line in my benchmark harness. Programs choose a **memory allocator**, the code behind every `malloc` and `free`. My harness used the system default, glibc's. polars ships with a different one, **jemalloc**, which is built for heavily multi-threaded programs.

| same code, allocator swapped | glibc scaling | jemalloc scaling |
|---|---|---|
| two-key top-k | 12.06x | **20.47x** |
| another two-key top-k | 15.70x | **20.19x** |
| TPC-H q18 | 16.23x | **19.82x** |
| a join (didn't care either way) | 21.58x | 21.82x |

**The finding flipped over.** Two-key top-k now scaled *better* than one-key. The bottleneck had been the allocator the whole time, not the missing optimization. That part of the code is still there to look at, but it has no measured cost, so the performance claim is withdrawn.

Everything else about that harness was right. Quiet machine. Stable clock speed. Sound statistics. Correct results on every run. And one missing line still manufactured a finding, complete with a mechanism and a supporting profile.

A benchmark that doesn't use the project's allocator isn't benchmarking the project. It's benchmarking the benchmark.

### An aside: the first query crashed

The very first probe query I wrote did something else entirely:

```text
thread 'main' panicked at crates/polars-stream/src/nodes/top_k.rs:488:24:
not implemented for dtype Int128
```

The query was just "top 20 rows sorted by a price column." Prices are stored as **decimals**, and polars keeps decimals as 128-bit integers internally. The sorting code does have a case for 128-bit integers. But that case is switched on by a compile-time feature flag, and Rust evaluates this particular flag where the code is *used*, not where it's *written*. The streaming engine's build never turned the flag on. Five of polars' internal packages turn it on correctly. Four don't.

The fix is one line in a build file. Python users never hit it, because the Python build enables the flag explicitly. Rust users could, with nothing more unusual than a Parquet file containing a decimal column.

Not what I was looking for. Worth finding anyway.

## The one-core hours

**Window functions** are the SQL feature for "compute something about each row relative to its group." Number the items within each order. Look up the previous item's price. Keep a running total per customer. They're everywhere in analytics.

<span class="clock">Wall clock</span> Two queries over the same 45 million orders and the same 180 million rows. The only difference is `order by` inside the window.

| query | what it computes | time | cores busy |
|---|---|---|---|
| sum per order | `sum() over (partition by l_orderkey)` | 2,488 ms | **17.25** |
| number rows within each order | `row_number() over (partition by l_orderkey order by ...)` | 49,015 ms | **2.27** |

Ask for the rows *in order* within each group, and it costs **20x**, while 22 cores sit idle.

And the polars authors are upfront about it. Here's the comment sitting on top of that code path:

```rust file="crates/polars-expr/src/expressions/window.rs"
// ... we can now relatively efficient arg_sort per group. This
// is still horrendously slow, but at least not as bad as it would be if you
// did this naively.
```

Nobody missed this. It was written down, in plain English, waiting.

### Few big groups: a sort told to stay home

When there are millions of groups, polars spreads the *groups* across threads and sorts each one on a single thread. With millions of groups, that's exactly right: plenty of work for everyone. The code says so directly, `multithreaded: false`, next to a comment that it's already running in parallel.

Now try **three** groups. Three threads each get one group, and each sorts 60 million rows alone.

Twenty-one cores. Idle. By construction.

**Attempt 1:** let each group's sort use all the threads when there are fewer groups than threads. The three-group query got 47% faster. Fireworks. Then a sweep across different group counts found a **50**-group query running **23.7% slower**. It should have been untouched, since 50 is not fewer than 24.

Stranger still, the slowdown came and went. Unmodified code varied 1% between rounds. Patched code sometimes matched it and sometimes came in 11-18% slower. A plain slowdown doesn't flicker like that.

Here's the thing though: **the same sorting function was called from a second place I hadn't read.** That second caller sorts *sub*-groups, from inside work that's already spread across every thread, where group counts are small. So my new rule kicked in there too, and launched parallel sorts inside parallel work. Threads fighting threads.

**Attempt 2** lets the caller say whether the thread pool is actually free, and only the top-level caller says yes. Three-group query: **-48.1%, -48.3%, -48.1%** over three rounds. Fifty-group query: flat.

A word on correctness, because this one is subtle. The package's test suite reported success. It had run **zero tests**, because that package has no tests of its own. I recorded that as "not run," not as a pass. What actually proves correctness is an argument. Both sorting routines are **stable**, meaning rows that tie keep their original order. Two stable sorts of the same data always produce the same result. If either had been unstable, row numbers for tied rows could differ between builds, and a row count would never notice.

### Many tiny groups: forty seconds at exactly one core

Now the other extreme: 45 million orders, about four rows each.

My first write-up blamed a specific loop, from **reading the code**. It was wrong: that loop only runs for a different kind of query. It's in the ledger at the end, where it belongs.

Phase timing found the real problem: from second 6 to second 47, **exactly one core busy.** A profile of just that window named the function: **74.67%** of the time inside a generic fallback routine, all on one thread.

<span class="clock">Design clock</span> polars' SQL layer implements `row_number()` as "make a range from 0 to the group's length, then add 1." Range-building has no specialized per-group implementation, so it falls back to a general-purpose path. That path loops over every group one by one: package each input into a standalone column object (a **Series**, polars' heap-allocated column type), call the function, collect the result. As a fallback for rarely used functions, that's perfectly sensible. `row_number()` is not rarely used.

<span class="clock">Machine clock</span> 45 million groups of about four rows, in roughly forty seconds on one core. That's about **half an hour** of dilated time per four-row group, mostly spent building and throwing away column objects around a four-number range.

**The fix:** a dedicated per-group version that builds every group's range into one output, in one pass. Same results, same error messages in the same order.

| query | before | after | change |
|---|---|---|---|
| row numbers, 45M groups | 50,716 ms | **13,111 ms** | **-74.15%**, 4/4 |
| row numbers, 6M groups | 14,885 ms | 8,587 ms | **-42.28%**, 6/6 |
| three controls | | | under 0.1%, noise |

Checked three ways. A checksum over all 179,998,372 rows: identical. A battery of 273 edge cases run through both builds: identical output, line for line, error messages included. And a profile confirmed the new code was actually running, with zero time left in the old path.

### LAG, LEAD, and the atomic nobody invited

`LAG(price)` means "the previous row's price, within this group." Sounds harmless. On 45 million groups it runs for **88.6 seconds. At 1.71 cores.**

It's the same generic fallback.

<span class="clock">Machine clock</span> Eighty seconds of one core, forty-five million groups. About an hour of dilated time per four-row group. And inside that hour, 16.6% goes to converting the "how many rows back" number to the right type. The same number. Forty-five million times.

So the obvious question: why fix one function when you could fix them all? Make the generic fallback loop run in parallel, and every function that uses it speeds up at once. I built that. It halved the time.

Then it stopped at ten cores.

Here's the thing though. Every group's input is a slice of *one* shared data buffer. Rust tracks who's using a shared buffer with a **reference count**: a counter bumped up when someone takes a slice and down when they let it go. Every slice, an increment. Every release, a decrement. One counter. Twenty-four cores.

And here's the hardware problem. Each core has its own cache, which works in 64-byte chunks called **cache lines**. When two cores write to the same cache line, the hardware has to shuttle that line between them. Only one core holds it at a time, and every hand-off costs time.

| where the parallel version spent its time | share |
|---|---|
| releasing slices | 27.72% |
| creating slices | 26.66% |
| copying slices | 12.84% |

Two thirds of the parallel phase was one cache line bouncing between cores. The regex pool again, in a new costume.

<span class="clock">Design clock</span> A shared reference count is exactly right for a buffer with a handful of users. It was never meant for 45 million short-lived slices across 24 cores. Nobody got this wrong. The workload just outgrew the design.

So the fix isn't smarter parallelism. It's not making 45 million column objects in the first place. Convert "how many rows back" once. Compute every group's shifted positions in one pass. **89.2 seconds to 19.4. -78.22%.** And the output checks itself: LAG should leave exactly one empty value per order, and it does.

Did it work? Every checksum said yes. Every hand-picked test said yes. A 410-case battery comparing both builds said no. In one unusual shape of query, the old code returned one value per group and mine returned a list. It was fixed, re-run, and matched on both builds.

The code got simpler. The query got 4.6x faster. Only one of those needed a test battery to believe.

## The ledger, so far

Everything in this post that I confidently wrote down and later had to correct:

| I said | what was actually true |
|---|---|
| The regex slowdown was in polars' general string code | That code already gave each thread its own regex. The bug was only in the Parquet reader |
| The regex fix is -61.5% | On the 4-channel machine. On 8 channels, -54% to -58.5% |
| Two-key top-k wastes ~80 ms | The allocator was the bottleneck. Withdrawn |
| TPC-H q18 hits the same top-k problem | Top-k is 0.21% of q18 |
| Two top-k queries made a controlled comparison | They read different columns |
| The row-numbering slowdown was a particular loop | That loop never runs for this query. I'd read code instead of profiling |
| One window query had ~1.5M groups | 6,000,000 |
| “Formatting check: clean” | The check had failed on a missing tool. I read the exit code of the wrong command |
| Two boundary queries "passed" | Both had crashed. The check compared two empty outputs and called them equal |

The last two belong together. **A missing tool looks exactly like a clean result.** Check that the tool actually ran, and treat empty output as a failure, not as agreement.

## What this part taught

1. **Change one variable and watch what moves.** One measurement can't tell threads fighting from threads working.
2. **Profiles average; timelines slice.** A single-threaded phase disappears into the average and stands out in the timeline.
3. **Benchmark with the project's own allocator.** Otherwise you're benchmarking your harness.
4. **Profile before you blame.** Both of my wrong attributions here came from reading code and never checking it against a profile.
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

<span class="clock">Wall clock</span> One last time. Someone types a query and waits.

Every table above is time handed back to them.

*Next in the series: **Twelve seconds at a time**, where a single core spends 17% of a query waiting on bytes it wrote a moment earlier, and three small patches that give most of it back.*
