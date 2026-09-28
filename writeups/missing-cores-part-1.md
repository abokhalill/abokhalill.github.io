---
title: "The Missing Cores: A 24-core machine is idle inside Polars?!"
dek: "This is part one of a season spent profiling the popular DataFrame library Polars."
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

It is easy to assume that an open source project or tool that is heavily optimized, especially one as fast as Polars, would likely mean that it has been profiled to death. But the truth is, high performance software is often where the most subtle inefficiencies take residence. To understand exactly where these inefficiencies lived, we need to first look at the skeletal diagram of Polars. You don’t need to be a core maintainer or developer of Polars. If you roughly know what a thread is and what a hash table does, you’ll be alright.

## What is Polars?

Polars is a DataFrame library. Think of pandas, rebuilt from the ground up in Rust with one obsession, which is using every single core your machine has. You describe a query in Python, Rust or SQL, Polars turns it into a plan, and then it executes that plan in parallel over data stored column by column. Very often that data comes straight out of Parquet files. These files are simply the compressed, columnar file format that has become the standard of the data world.

Polars actually has two execution engines. The older in-memory engine loads what it needs and works on it as a whole. The newer streaming engine pushes data through in batches. We will draw on this distinction more as we encounter it.

**The workload.** In order to profile at all, we need to simulate an instance where Polars is actively utilizing the machine's resources to see where the bottleneck lies. That in mind, we used TPC-H, the industry's standard analytics benchmark. It models a made-up wholesaler with customers, orders, and the individual line items on each order. To control the amount of data we want to simulate, we set a scale factor. It is simply a multiplier that defines the total size of the test database and the number of rows in its tables (eg. SF10 = 10GBs of data). At scale factor 30, the `lineitem` table alone holds 180 million rows, and `orders` holds 45 million. You will often see query numbers like 6, 15, 22, etc. These are the TPC-H queries. Anything numbered higher is a custom probe that we designed to stress specific parts of the system.

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

24 times the man power but only 7.5x faster? Roughly seventy percent of the machine is just not there.

Before we see where the rest of the machine went, there's a critical observation to be made here. Polars doesn't read all 180 million comments and *then* filter them. It pushes the filter down into the Parquet reader, which tests each value the moment it's decoded and throws the losers away on the spot. This is called predicate pushdown. The filter here is just a plain old regex from SQL's `LIKE`.

A regex engine needs scratch memory while it scans in order to keep track of where it is inside the pattern. Allocating fresh scratch memory for every one of 180 million matches would be painfully slow, so the regex library keeps a pool of scratch buffers and lends them out.

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

The problem arises when Polars compiles one regex and hands that same object to every thread decoding the file. So again, in essence, one thread owns the pool while the twenty three siblings wait for it to release the mutex.

But how can we even be sure that's what's happening? Well, the profiler practically confesses. The hottest function is `Pool::put_value`, the code that *returns* a borrowed buffer, and it only ever runs when the returning thread isn't the owner. If every thread had its own regex, that function wouldn't show up at all.

The fix is relatively straightforward: give each thread its own copy of the regex, through a per-thread regex cache Polars already had elsewhere.

<span class="clock">Wall clock</span> To say this had a meaningful impact was an understatement, and the numbers leave no room for discussion.

| 8-channel machine | before | after | change |
|---|---|---|---|
| `like '%special%'` | 2544.0 ms | 1085.9 ms | -57.23%, t=-64.33, 6/6 |
| `like 'the%'` | 1835.3 ms | 677.8 ms | -62.85%, 6/6 |
| control, no regex | 237.4 ms | 235.4 ms | -0.86% |

On the 8-channel machine, scaling jumped from 8.6x to 20.4x, while the single-thread time barely moved. This directly aligns with our previous hypothesis, which claimed that the owning thread always had the free lane, and so a correct fix *has* to change nothing at one thread and a lot at 24, which again, checks out.

<span class="clock">Machine clock</span> Let's follow that same row one last time. At twenty-four threads, it used to cost about 15 minutes of thread time. With the patch now applied, it costs about 6. For comparison, the very same row costs about 5 minutes on a single thread, where there is nobody to wait on. In other words, the row is back to doing its own work and not much else.

*(same method as the cycles table above)*

## Flying blind

Before we go any further, it's worth taking a step back, because contrary to popular belief, or rather, the current probable circulating intuition, none of these findings actually surfaced from a single profile. 

A profiler is excellent at exactly one thing: telling you what the *already* busy cores are doing. That is, each core that's actively being utilized has a meticulous stack trace showing exactly what it's working on.

But the problem kind of already spells itself here. What about cores that are sitting completely idle? To put it simply, if the full 24 cores are expected to be working, how do we know that's the case? And the more perplexing question, what triggered an investigation into this in the first place?

This was how the regex bug was found. We changed the thread count, and watched how the profile moved. At one thread, zero time in the pool. At four, a third of it. At twenty-four, half. This was what triggered the so called investigation, which unfortunately no profiler can show.

Running that same sweep across 45 queries led us to a second instrument. Linux's `perf stat` reports how many CPUs were actually utilized on average, split into two kinds of failures:

- **Busy cores, bad scaling.** The cores are working, but on wasted effort, that's the regex pool.
- **Idle cores, bad scaling.** The work simply isn't there to do. As we just concluded, this looks completely clean on a profiler.

So how do you see time that leaves no trace in the profile?

Enter phase timing. Chop the run into one second buckets and count how many cores were busy in each one. On a 24-core machine, one thread grinding away alone for forty seconds is only a *tiny* fraction of the total samples. In one example, as we're about to see, one query's profile looked completely flat, with its top function at a mere 4%. But the phase timeline for that very same query showed exactly one core busy, from second 6 to second 47.

## The overworked worker

To demystify this next anomaly, a few terms are justified to be explained. 

Group / partition: It is simply a way to classify data into distinct piles before doing a calculation. 

SQL window functions: A window function is an SQL feature used to compute something about each row relative to its group. An example would be `SUM() OVER ()` to sum or `ROW_NUMBER() OVER ()` to assign a unique index to each row number. 

This now loaded into context, it is intuitive to guess that such functions are practically everywhere in analytics.

<span class="clock">Wall clock</span> Here are two queries over the same 45 million orders and the same 180 million rows. The only difference between the two is an `order by` inside the window.

| 4-channel machine | what it computes | time | cores busy |
|---|---|---|---|
| sum per order | `sum() over (partition by l_orderkey)` | 2,617 ms | 23.06 |
| number rows within each order | `row_number() over (partition by l_orderkey order by ...)` | 50,492 ms | 2.29 |

Once again, the disaster becomes immediately crystal. Asking for the rows *in order* within each group costs a staggering 19x, while nearly 22 cores sit around completely idle. History kind of repeats itself here yet again. However, only this time, the Polars authors are aware of this and in fact are disarmingly transparent about it:

```rust file="crates/polars-expr/src/expressions/window.rs"
// ... we can now relatively efficient arg_sort per group. This
// is still horrendously slow, but at least not as bad as it would be if you
// did this naively.
```

<span class="clock">Machine clock</span> There's another observation to be made here. If you tally the work across all 24 cores and split it per row, `SUM()` comes out to be about 12 minutes of dilated time. `ROW_NUMBER()` about 22. 

But on the wall clock, a row comes out of the sum in just 30 seconds, and takes close to 10 minutes for row numbering. So if my math is correct, that should be about 1.8x the compute stalled behind a 19x latency wall. 22 of your cores simply clocked out.

### Few big groups

<span class="clock">Design clock</span> When there are millions of small groups, Polars distributes the groups across available threads and sorts each group sequentially. Because there are millions of groups, there is plenty of work to go around, and so there will rarely be any time wasted where a thread at any moment isn't being utilized. We have a perfect balance of work distribution and parallelization.

However, this is not so trivial when your dataset contains millions of rows divided into only a few groups. If we wanted for instance to have those 180M rows split into three groups of 60M rows, we would only have three threads clocked in for work. That is, each thread is sorting 60M rows alone. The rest of the twenty one threads would sit doing nothing. 

If we are to solve this purely by intuition, the first thing that would naturally come to mind is to have every group sort use every single thread available whenever we have fewer groups than we have threads. For example, if we had 19 groups and 24 threads, instead of each thread getting its own group and five sitting idle, we could allow individual group sorts to parallelize across the extra thread capacity. This would be implemented using some kind of parallel sort logic like a merge sort or Polars' own Rayon-based parallel sorting.

While this does work in simple cases, it is difficult to generalize and introduces a subtlety: what happens when a worker thread already running in parallel spawns its own sub-parallel sort? You get nested parallelism. This causes dozens of worker threads to begin tearing each other apart for the same physical 24 CPU cores; a state known as oversubscription, which leads to constant context switching and erratic performance.

To fix this is to have the query engine answer one extra question: who am I?

The sorting function is updated to accept an extra parameter: a boolean flag to indicate whether or not the caller is a top level caller owning the thread pool, or a nested child caller running inside an already parallelized worker thread. 

If the caller is a top level parent, it passes `pool_is_free = true`. The sorting routine then checks this flag and sees that the 24 cores are genuinely idle. Having cleared the background check, it then expands the single group’s sort across all 24 threads using parallel algorithms such as Rayon. 

Likewise, if the caller is instead a nested child, then the flag passed is `false` and the background check fails. 

It’s a simple yet elegant solution. For the two scenarios, whether or not we have few big groups or many nested sub sorts, we will either drop the execution time by a meaningful margin or we will have zero performance flicker. The many group query will stay rock solid flat, completely immune to oversubscription and unpredictable variance.

<span class="clock">Wall clock</span> And so it did. With three groups, the query went from 20.4 seconds to 10.6, three rounds consecutively: -48.1%, -48.3%, -48.1%. The machine went from about 3 cores busy to about 7. A fifty group query, one that would have resulted in skewed metrics, stayed flat.

| 8-channel machine | before | after | change |
|---|---|---|---|
| 3 groups | 20,402 ms | 10,557 ms | -48.1%, -48.3%, -48.1% |
| 50 groups | | | flat |

So why only seven cores and not the full twenty-four? Honestly, we have no idea yet. The seven cores is an average over the whole query. In other words, if there's anything else that is still running on one single core, that would be what is causing the number to be dragged down because it's not being distributed over the whole 24 cluster.

<span class="clock">Machine clock</span> Spread over all 180 million rows, that's about 4 minutes of waiting per row before the fix, and about 2 after.

### Many tiny groups

Now the other extreme: 45 million groups, about four rows each.

<span class="clock">Wall clock</span> The ordered query from earlier, the one that numbers the rows within each order, takes 50.7 seconds. And for 41 of those seconds, exactly one core is doing anything at all.

Once again, this is phase timing in motion, which shows that exactly one core is active from t=6s to t=47s. A profile of just that window finally uncovers the mystery: 74.67% of the time sits inside a generic fallback routine, all of it on a single thread.

<span class="clock">Machine clock</span> 45 million groups of about four rows, in roughly forty seconds on one core. That works out to about half an hour of dilated time per four-row group. Half an hour, to count to four. Ironically, most of this time is not even dedciated to anything analytical, it's just constant memory allocation and freeing due to the millions of tiny groups.

<span class="clock">Design clock</span> Polars’ SQL layer implements `ROW_NUMBER()` with naive simplicity: generate a range from 0 to the group's length, then add 1. But because range-building lacked a dedicated per-group path, the query planner defaulted to its general purpose fallback.

This fallback processes all 45 million groups one by one: wrap the input into a standalone, heap-allocated `Series` object, invoke the function, extract the result, and discard the wrapper. For an obscure utility function, it could be argued that this overhead is somewhat reasonable. The flaw, of course, is that `ROW_NUMBER()` is anything but rarely used.

The solution? A dedicated per-group version that builds every group's range into one output in a single pass, with the same results and the same error messages in the same order.

| 4-channel machine | before | after | change |
|---|---|---|---|
| row numbers, 45M groups | 50,716 ms | 13,111 ms | -74.15%, 4/4 |
| row numbers, 6M groups | 14,885 ms | 8,587 ms | -42.28%, 6/6 |
| three controls | | | under 0.1%, noise |

![](/figures/fig2-row-number-timeline.svg)

<span class="clock">Machine clock</span> The new range builder gets through all 45 million groups in about a second and a half, still on one core. That's roughly a minute of dilated time per group, down from half an hour. 

Because this is such a significant speedup, correctness tests here matter much much more. After all, if your claimed speedup results in incorrect output, it's not a speedup at all.

To verify, we checked three things. A checksum over all 179,998,372 rows came out identical. A battery of 273 edge cases, run through both builds, produced identical output line for line. And as one last line of defense, a profile confirmed the new code was actively running.

### LAG, LEAD, and the atomic nobody invited

<span class="clock">Wall clock</span> `LAG(price)` means "the previous row's price, within this group." On 45 million groups, it runs for 88.6 seconds at 1.71 cores. Anything look particularly familiar? It's the exact same generic fallback as before.

<span class="clock">Machine clock</span> Eighty seconds of one core over 45M groups works out to about an hour of dilated time per four-row group. That's twice as bad as row numbering. And inside that hour, 16.6% goes to converting the "how many rows back" number into the right type. The same number, forty-five million times over.

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

So the fix isn't smarter parallelism. It's not creating 45 million column objects in the first place. Convert "how many rows back" once, then compute every group's shifted positions in a single pass.

<span class="clock">Wall clock</span> Paired, round after round, 89.2 seconds came down to 19.4. That's -78.22%, four rounds out of four. And the output checks itself: `LAG()` should leave exactly one empty value per order, and it does.

![](/figures/fig3-lag-timeline.svg)

<span class="clock">Machine clock</span> The new shift gets through all 45 million groups in about eight seconds of one core. That's roughly 6 minutes per group, down from an hour. Still not free, and there's a clear way to make it cheaper, but that's a story for another day.

This fix isn't upstream yet. It waits on a design question a maintainer raised about the row-numbering fix, since both hook in at the same place.

Did it work? Every checksum said yes. Every hand-picked test said yes. A 410-case battery comparing both builds said no. In one unusual shape of query, the old code returned one value per group and ours returned a list. We fixed it, re-ran the battery, and both builds matched.

The query got 4.6x faster. Believing it was still right took a battery of 410 cases.

---

*Next in the series: Twelve seconds at a time, where a single core spends 17% of a query waiting on bytes it wrote a moment earlier, and three small patches that give most of it back.*
