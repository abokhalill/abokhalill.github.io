---
title: "The Missing Cores: A 24-core machine is idle inside polars?!"
dek: "This is part one of a season spent profiling the popular DataFrame library polars. It covers a regex that leaves 23 of 24 threads stuck in line for a lock, window functions that run for a staggering forty seconds on one core, and a benchmark accident that invented a finding out of thin air."
date: 2026-09-25
image: og-missing-cores-part-1.png
---

To kind of give you a present sense of the effects each of these findings had, we will run each one through three clocks.

<aside class="clocks">
<dl>
<dt>Wall clock</dt>
<dd>What the end user waits for. This is the physical wall time.</dd>
<dt>Machine clock</dt>
<dd>Because computers are too fast to feel, we will slow one down. We will choose one cycle to equal one second. So to map this to the real world, an L1 cache hit would be analogous to a heartbeat. Fetching data from main memory would be the equivalent of a coffee break. And as we’re about to see, a four-row calculation that should take a blink will take about half an hour.</dd>
<dt>Design clock</dt>
<dd>Why the source code looks the way it does.</dd>
</dl>
<p>This is already intuitive to deduce, and it should go without saying, but every claim or finding in this writeup was measured with the exact setup and test machine listed.</p>
</aside>

It is easy to assume that an open source project or tool that is heavily optimized, especially one as fast as polars, would likely mean that it has been profiled to death. But the truth is, high performance software is often where the most subtle inefficiencies take residence. To understand exactly where these inefficiencies lived, we need to first look at the skeletal diagram of polars. You don’t need to be a core maintainer or developer of polars. If you roughly know what a thread is and what a hash table does, you’ll be alright.

## What is polars?

polars is a DataFrame library. Think of pandas, rebuilt from the ground up in Rust with one obsession, which is using every single core your machine has. You describe a query in Python, Rust or SQL, polars turns it into a plan, and then it executes that plan in parallel over data stored column by column. Very often that data comes straight out of Parquet files. These files are simply the compressed, columnar file format that has become the standard of the data world.

polars actually has two execution engines. The older in-memory engine loads what it needs and works on it as a whole. The newer streaming engine pushes data through in batches. We will draw on this distinction more as we encounter it.

**The workload.** In order to profile at all, we need to simulate an instance where polars is actively utilizing the machine's resources to see where the bottleneck lies. That in mind, we used TPC-H, the industry's standard analytics benchmark. It models a made-up wholesaler with customers, orders, and the individual line items on each order. To control the amount of data we want to simulate, we set a scale factor. It is simply a multiplier that defines the total size of the test database and the number of rows in its tables (eg. SF10 = 10GBs of data). At scale factor 30, the `lineitem` table alone holds 180 million rows, and `orders` holds 45 million. You will often see query numbers like 6, 15, 22, etc. These are the TPC-H queries. Anything numbered higher is a custom probe that we designed to stress specific parts of the system.

**The test machine.** An Intel Xeon Gold 5412U with 24 cores and 48 hardware threads, with turbo boost switched off. This isn't particularly all that important if you're just passively reading and do not care much about reproducing these numbers, but the machine ran with only 4 memory channels for the first half of the season and 8 for the second. You will sometimes see tables labeled with "8 channel machine" and other tables with "4 channel machine". Again, this isn't all that important but it's worth clarifying.

**How to read the tables.** Every before-and-after comparison is a *paired A/B*: the unchanged build ("stock") and the modified build ("patched") run alternately, round after round. The purpose of this is to minimize bias, with each result accompanied by three numbers:

- "6/6" means the patched build won all six rounds.
- t is a t-statistic. Anything beyond roughly ±3 is far outside what is considered noise. For example, a t of about -64 should make you sit upright.
- CI is the 95% confidence interval for the change.

As an extra layer of redundancy or "sanity check", an extra control query was added to each experiment. This played the key role of confirming that the change under test was indeed the cause of the observed effect. In other words, if this control query that had nothing to do with the change does move, it means the benchmark harness itself was flawed.

## One owner, twenty-three borrowers

<span class="clock">Wall clock</span> Let's start with a single question, asked of 180 million shipping comments:

```sql
select count(*) from lineitem where l_comment like '%special%'
```

On one thread, the answer takes 20.6 seconds. On twenty-four threads, it takes 2.76. At firts glance, this is immediately puzzling.

24 times the man power but only 7.5x faster. Roughly seventy percent of the machine is just not there.

Before we see where the rest of the machine went, there's a critical observation to be made here. polars doesn't read all 180 million comments and *then* filter them. It pushes the filter down into the Parquet reader, which tests each value the moment it's decoded and throws the losers away on the spot. This is called predicate pushdown, and it's a genuinely good idea. The filter here is just a plain old regex from SQL's `LIKE`.

A regex engine needs scratch memory while it scans, to keep track of where it is inside the pattern. Allocating fresh scratch memory for every one of 180 million matches would be painfully slow, so the regex library keeps a pool of scratch buffers and lends them out.

<span class="clock">Machine clock</span> Now follow a single row. On one thread, deciding whether one comment contains `special` takes about 4 minutes of dilated time, and about 2 of those minutes are the actual search.

Give the same query 24 threads and follow the same row again. The search still takes about 2 minutes, but the row now costs about 13 minutes, and roughly 6 of them are spent waiting to borrow a scratch buffer.

*(total thread time divided by 180M rows, converted to cycles)*

| threads | cycles per row | searching | borrowing the buffer |
|---|---|---|---|
| 1 | ~241 | ~127 | ~0 |
| 4 | ~484 | ~153 | ~158 |
| 24 | ~772 | ~139 | ~372 |

![](/figures/fig1-regex-cycles-per-row.svg)

It does not take a rocket scientist to notice the pattern depicted here. The time it takes to do the searching is exactly the same no matter the thread count. The threads are all waiting for each other to borrow the buffer.

<span class="clock">Design clock</span> The pool keeps one slot that needs no locking, and it reserves that slot for whichever thread used the regex first. Every other thread has to go through a mutex. So whichever lucky thread happens to win this race, the rest of the threads sit idle in a queue. The reason behind this design in the first place was that the pool was built around a regex that one thread owns and uses on its own. In that case, every borrow goes through the free slot and the mutex is never touched.

The problem arises when polars compiles one regex and hands that same object to every thread decoding the file. So again, in essence, one thread owns the pool while the twenty three siblings wait for it to release the mutex.

But how can we even be sure that's what's happening? Well, the profiler practically confesses. The hottest function is `Pool::put_value`, the code that *returns* a borrowed buffer, and it only ever runs when the returning thread isn't the owner. If every thread had its own regex, that function wouldn't show up at all.

The fix is relatively straightforward: give each thread its own copy of the regex, through a per-thread regex cache polars already had elsewhere. To say this had a meaningful impact was an understatement, and the numbers leave no room for discussion.

| 8-channel machine | before | after | change |
|---|---|---|---|
| `like '%special%'` | 2544.0 ms | 1085.9 ms | -57.23%, t=-64.33, 6/6 |
| `like 'the%'` | 1835.3 ms | 677.8 ms | -62.85%, 6/6 |
| control, no regex | 237.4 ms | 235.4 ms | -0.86% |

Scaling jumped from 8.6x to 20.4x, while the single-thread time barely moved. This directly aligns with our previous hypothesis, which claimed that the owning thread always had the free lane, and so a correct fix *has* to change nothing at one thread and a lot at 24, which again, checks out.

Same patch, two machines, two correct numbers.

## Flying blind

Before we go any further, it's worth taking a step back, because counter-intuitevely, none of these findings surfaced from profiler data. 

A profile is excellent at exactly one thing: telling you what the *already* busy cores are doing. That is, each core that's actively being utilized has a meticulous stack trace showing exactly what it's working on.

But the problem kind of already spells itself here. What about cores that are sitting completely idle? To put it simply, if the full 24 cores are expected to be working, how do we know that's the case? And the more perplexing question, what triggered an investigation into this in the first place?

This was how the regex bug was found. We changed the thread count, and watched how the profile moved. At one thread, zero time in the pool. At four, a third of it. At twenty-four, half. This was what triggered the so called investigation, which unfortunately no profiler can show.

Running that same sweep across 45 queries led us to a second instrument. Linux's `perf stat` reports how many CPUs were actually utilized on average, split into two kinds of failures:

- **Busy cores, bad scaling.** The cores are working, but on wasted effort, that's the regex pool.
- **Idle cores, bad scaling.** The work simply isn't there to do. As we just concluded, this looks completely clean on a profiler.

So how do you see time that leaves no trace in the profile?

Enter phase timing. Chop the run into one second buckets and count how many cores were busy in each one. On a 24-core machine, one thread grinding away alone for forty seconds is only a *tiny* fraction of the total samples. In one example, one query's profile looked completely flat, with its top function at a mere 4%. But the phase timeline for that very same query showed exactly one core busy, from second 6 to second 47.

## The one-core hours

Window functions are the SQL feature for "compute something about each row relative to its group." Number the items within each order. Look up the previous item's price. Keep a running total per customer. They're everywhere in analytics, which is exactly why what follows matters.

<span class="clock">Wall clock</span> Here are two queries over the same 45 million orders and the same 180 million rows, on the 4-channel machine. The only difference between them is an `order by` inside the window.

| query | what it computes | time | cores busy |
|---|---|---|---|
| sum per order | `sum() over (partition by l_orderkey)` | 2,617 ms | 23.06 |
| number rows within each order | `row_number() over (partition by l_orderkey order by ...)` | 50,492 ms | 2.29 |

Asking for the rows *in order* within each group costs a staggering 19x, while nearly 22 cores sit around doing nothing.

And the polars authors are completely upfront about it. Here's the comment sitting right on top of that code path:

```rust file="crates/polars-expr/src/expressions/window.rs"
// ... we can now relatively efficient arg_sort per group. This
// is still horrendously slow, but at least not as bad as it would be if you
// did this naively.
```

Nobody missed this. It was written down, in plain English, waiting for someone to pick it up.

### Few big groups: a sort told to stay home

When there are millions of groups, polars spreads the *groups* across threads and sorts each one on a single thread. With millions of groups, that's exactly right: there's plenty of work to go around. The code even says so, `multithreaded: false`, right next to a comment noting that it's already running in parallel.

Now try three groups. Three threads each get one group, and each of them sorts 60 million rows alone.

That leaves twenty-one cores idle. By construction.

**Attempt 1:** let each group's sort use all the threads whenever there are fewer groups than threads. The three-group query got 47% faster. Then a sweep across different group counts turned up a 50-group query running 23.7% slower. That query should never have been touched, since 50 is not fewer than 24.

Stranger still, the slowdown came and went. The unmodified code varied by 1% between rounds. The patched code sometimes matched it and sometimes came in 11-18% slower. A plain slowdown doesn't flicker like that.

Here's the thing though: the same sorting function was called from a second place we hadn't read. That second caller sorts *sub*-groups from inside work that's already spread across every thread, where group counts are naturally small. So our new rule kicked in there too, and launched parallel sorts inside parallel work. Threads fighting threads.

**Attempt 2** lets the caller say whether the thread pool is actually free, and only the top-level caller says yes. The three-group query: -48.1%, -48.3%, -48.1% over three rounds. The fifty-group query: flat. (These sort measurements are from the 8-channel machine.)

A word on correctness here, because this one is subtle. The package's test suite reported success. It had run zero tests, because that package has no tests of its own. We recorded that as "not run," not as a pass. What actually proves correctness is an argument: both sorting routines are stable, meaning rows that tie keep their original order, and two stable sorts of the same data always produce the same result. Had either been unstable, row numbers for tied rows could differ between builds, and a simple row count would never have noticed.

### Many tiny groups: forty seconds at exactly one core

Now the other extreme: 45 million orders, about four rows each.

Our first write-up blamed a specific loop, based on reading the code. It was wrong. That loop only runs for a different kind of query. It's in the ledger at the end, where it belongs.

Phase timing found the real problem: from second 6 to second 47, exactly one core busy. A profile of just that window named the culprit: 74.67% of the time sat inside a generic fallback routine, all of it on a single thread.

<span class="clock">Design clock</span> polars' SQL layer implements `row_number()` as "make a range from 0 to the group's length, then add 1." Range-building has no dedicated per-group implementation, so it falls back to a general-purpose path. That path walks every group one by one: package each input into a standalone column object (a Series, polars' heap-allocated column type), call the function, collect the result. As a fallback for rarely used functions, that's perfectly sensible. The problem is that `row_number()` is anything but rarely used.

<span class="clock">Machine clock</span> 45 million groups of about four rows, in roughly forty seconds on one core. That works out to about half an hour of dilated time per four-row group, mostly spent building and throwing away column objects around a four-number range.

**The fix** is a dedicated per-group version that builds every group's range into one output in a single pass, with the same results and the same error messages in the same order.

| 4-channel machine | before | after | change |
|---|---|---|---|
| row numbers, 45M groups | 50,716 ms | 13,111 ms | -74.15%, 4/4 |
| row numbers, 6M groups | 14,885 ms | 8,587 ms | -42.28%, 6/6 |
| three controls | | | under 0.1%, noise |

![](/figures/fig2-row-number-timeline.svg)

We checked it three ways. A checksum over all 179,998,372 rows came out identical. A battery of 273 edge cases, run through both builds, produced identical output line for line, error messages included. And a profile confirmed the new code was actually running, with zero time left in the old path.

### LAG, LEAD, and the atomic nobody invited

`LAG(price)` means "the previous row's price, within this group." Sounds harmless, right? On 45 million groups it runs for 88.6 seconds, at 1.71 cores. It's the same generic fallback as before.

<span class="clock">Machine clock</span> Eighty seconds of one core over forty-five million groups works out to about an hour of dilated time per four-row group. And inside that hour, 16.6% goes to converting the "how many rows back" number into the right type. The same number, forty-five million times over.

So the obvious question is: why fix one function when you could fix them all? Make the generic fallback loop run in parallel, and every function that relies on it speeds up at once. We built exactly that, and it halved the time.

Then it stopped dead at ten cores.

Here's the thing though: every group's input is a slice of *one* shared data buffer. Rust tracks who's using a shared buffer with a reference count, a counter that goes up when someone takes a slice and down when they let it go. Every slice is an increment. Every release is a decrement. One counter, twenty-four cores.

And this is where the hardware bites. Each core has its own cache, which works in 64-byte chunks called cache lines. When two cores write to the same cache line, the hardware has to shuttle that line back and forth between them. Only one core can hold it at a time, and every hand-off costs time.

| where the parallel version spent its time | share |
|---|---|
| releasing slices | 27.72% |
| creating slices | 26.66% |
| copying slices | 12.84% |

Two thirds of the parallel phase was one cache line bouncing between cores. It's the regex pool all over again, just in a new costume.

<span class="clock">Design clock</span> A shared reference count is exactly right for a buffer with a handful of users. It was never meant for 45 million short-lived slices across 24 cores. Nobody got this wrong. The workload simply outgrew the design.

So the fix isn't smarter parallelism. It's not creating 45 million column objects in the first place. Convert "how many rows back" once, then compute every group's shifted positions in a single pass: 89.2 seconds down to 19.4, or -78.22%. And the output checks itself: LAG should leave exactly one empty value per order, and it does. This fix isn't upstream yet. It waits on a design question a maintainer raised about the row-numbering fix, since both hook in at the same place.

![](/figures/fig3-lag-timeline.svg)

Did it work? Every checksum said yes. Every hand-picked test said yes. A 410-case battery comparing both builds said no. In one unusual shape of query, the old code returned one value per group and ours returned a list. We fixed it, re-ran the battery, and both builds matched.

The code got simpler and the query got 4.6x faster, but only one of those needed a test battery to believe.

---

*Next in the series: Twelve seconds at a time, where a single core spends 17% of a query waiting on bytes it wrote a moment earlier, and three small patches that give most of it back.*