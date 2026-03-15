---
title: "We ran lshaz on Abseil. Here's what compile-time microarchitectural analysis actually finds in production C++."
description: "lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships."
---

*lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships.*

---

One thing you and I can agree on: no software system is perfect on all aspects. In our unfortunate case, we discuss performance. Whether it's a naive struct spanning multiple cache lines, false sharing, an overly strong memory ordering being expensive for no beneficial reason, an unfriendly NUMA topology, you name it. We've all seen it. Okay maybe not all but these are generally NOT what you want in a latency sensitive pipeline.

The tool presented, lshaz, is a static analyzer that maps code which compiles, looks correct, and even passes code review, to silent hardware failures. This blog delves particularly into the non-trivial findings on Abseil, a common C++ library by Google written by the most hardware-conscious engineers on the planet.

---

## The tool in action

Before we peek at what's under the Christmas tree, let's first take a step back and really understand what we're working with here. lshaz is a Clang/LLVM-based static analyzer that surfaces microarchitectural 'hazards' that standard compilers usually ignore.

The main entry point uses `ASTContext` to query `ASTRecordLayout`. Sadly, this is where the abstraction ends. From this point, one `RecursiveASTVisitor` walks the AST, basically taking a stroll through your code. Every time it encounters a struct, class, or union, it stops, which is `CXXRecordDecl`. This allows it to compute the individual byte offsets at every field inside your struct. There are 15 individual rules, each mapping with a unique hardware mechanism.

However, there's something you're probably wondering: what if most of these warnings are just complete false positives? What if the struct spanning multiple lines is a struct you access once a year anyways? What if a virtualized call gets devirtualized by the compiler? What about heap allocation that gets inlined? Essentially, how do we guarantee the tool is reliable at scale?

Enter the IR refinement. IR, or Intermediate Representation, is a strongly typed assembly-like programming language. You can think of it as a layer somewhat between the high-level source code and the low-level machine code. Its sole purpose is to verify whether that specific hazard flagged still exists after compiler optimization. If the same false sharing hazard still exists inside a hot loop after the IR pass, we got ourselves a 'proven' hazard. The confidence score is escalated and the hazard is now a verified finding worth auditing.

It's worth noting that this pass is optional with the `--no-ir` flag disabling it. Why disable it you might ask? Because it saves your precious time with the tragic sacrifice of only having your findings at 'likely' or 'speculative'.

There's obviously still a ton to be said about the tool's capabilities, design and architecture, but having everyone on the same page while being familiar with the tool's motivation is crucial before we uncover the Abseil findings.

---

## The Abseil Findings

At last, the fireworks. Or is it? Let's dive in.

Abseil is maintained by engineers who think about cache lines for a living. If lshaz was going to embarrass itself, this was the place. 157 translation units, zero failures, 352 diagnostics. 18 FL002 false sharing findings, 100% precision at the critical tier. No false positives on a codebase this well engineered. That's the headline. Now let's talk about what it actually found.

### HashtablezInfo

The anchor finding is `HashtablezInfo` in `absl/container/internal/hashtablez_sampler.h`. This is the per-table sampling record for Abseil's SwissTable implementation, which is the hash map that runs inside essentially everything Google ships. When profiling is enabled, every sampled table gets a `HashtablezInfo` allocated from a global pool.

The Abseil authors are upfront about it:
```cpp
// These fields are mutated by the various Record* APIs and need to be
// thread-safe.
std::atomic<size_t> capacity;
std::atomic<size_t> size;
std::atomic<size_t> num_erases;
std::atomic<size_t> num_rehashes;
std::atomic<size_t> max_probe_length;
std::atomic<size_t> total_probe_length;
std::atomic<size_t> hashes_bitwise_or;
std::atomic<size_t> hashes_bitwise_and;
std::atomic<size_t> max_reserve;
```

Nine atomic fields. All thread-safe by design. All packed across 3 cache lines, producing over 40 pairwise false sharing interactions. Every hash table insert, erase, or rehash updates multiple of these atomics concurrently. When multiple threads operate on different sampled tables whose `HashtablezInfo` records land adjacently in the pool, the false sharing compounds.

The fix is textbook field reordering: group the hot counters onto a dedicated `alignas(64)` line, probe stats onto another, hash stats onto a third. The memory cost is negligible. The contention cost under concurrent workloads is not.

### ThreadIdentity

Now this is fireworks. `ThreadIdentity` in `absl/base/internal/thread_identity.h` contains three atomics that share cache lines with each other and with surrounding fields:
```cpp
// The following variables are mostly read/written just by the
// thread itself.  The only exception is that these are read by
// a ticker thread as a hint.
std::atomic<int> ticker;      // Tick counter, incremented once per second.
std::atomic<int> wait_start;  // Ticker value when thread started waiting.
std::atomic<bool> is_idle;    // Has thread become idle yet?
```

`ticker` is incremented on every mutex acquisition by the owning thread. `wait_start` and `is_idle` are written by other threads during signaling. When thread A signals thread B's semaphore, A writes to B's `ThreadIdentity`. If B is simultaneously updating its own `ticker`, the shared cache line ping-pongs between cores.

Here's the thing though. The Abseil authors knew. That comment above the fields; "the only exception is that these are read by a ticker thread as a hint", is the hardware trade off documented in plain English. This is not a bug anyone missed. It's a deliberate cost made visible only if you compute the byte offsets manually.

So in a way, while it didn't exactly end in a 'gotcha', the Abseil authors' comments validate that the tool pointed at something not so trivial at first glance. That's exactly what lshaz does. The struct is already 352 bytes, reordering `ticker` onto its own line costs zero additional memory. Well played.

### MutexGlobals

`MutexGlobals` in `absl/synchronization/mutex.cc` is the global configuration for every `absl::Mutex` spin decision:
```cpp
struct ABSL_CACHELINE_ALIGNED MutexGlobals {
  absl::once_flag once;
  std::atomic<int> spinloop_iterations{0};
  int32_t mutex_sleep_spins[2] = {};
  absl::Duration mutex_sleep_time;
};
```

Notice `ABSL_CACHELINE_ALIGNED` on the struct. The authors knew this needed cache line alignment and applied it correctly at the struct boundary. But alignment at the boundary doesn't isolate fields from each other within it. `spinloop_iterations` still shares a line with `once`, `mutex_sleep_spins`, and `mutex_sleep_time`. Every `absl::Mutex::Lock` reads `spinloop_iterations` to determine spin count. If anything touches the adjacent fields during initialization, it invalidates every thread's cached spin count simultaneously.

One global, every mutex operation, one cache line. The struct is already aligned. The fix is isolating `spinloop_iterations` onto its own line within it. The exposure is not trivial.

## Conclusion

If we had to flatten everything onto one sentence, it's that we believe lshaz is a genuine tool which benefits developers, engineers and traders alike. At the time of this writing, the tool has already been benchmarked and tested against other industrial OSS such as Redis, PostgreSQL, and the entire LLVM monorepo, with significant findings across all 3 codebases. Those write-ups are coming.

The tool's full source code can be found at https://github.com/abokhalill/lshaz. Supports both C and C++. Try it on your own project and let us know!