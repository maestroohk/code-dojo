# The quality bar: ready for a fast-paced workplace

Someone who finishes a topic here should be productive in their first weeks at a demanding employer
(Microsoft, Google, a fast startup): able to do the real work, debug the real failures, use the real tools
and hold their own in a design review. Every topic, module and lesson is judged against this page.

## The ten rules

1. **Real work, not trivia.** Every module ends with something people actually do on the job: ship a
   feature, debug a production issue from its symptoms, review a pull request, automate a chore, read
   logs, answer an incident. Toy examples are fine to introduce an idea, never to finish one.
2. **The real tools, with the flags seniors use.** Teach the industry-standard command, library or API by
   name, and the options that matter in practice (`git rebase -i --autosquash`, `kubectl get -o wide`,
   `docker compose logs -f --since`, `kafka-consumer-groups --describe`, `rg -n -C2 --glob`). Each module
   has a short "senior's toolkit" card: the commands and shortcuts someone experienced reaches for.
3. **Debugging and failure, every module.** At least one exercise starts from a symptom (an error message,
   a stack trace, a log line, a failing test, a metric) and asks the learner to find and fix the cause.
4. **Production thinking.** Performance, security, observability, failure modes and trade-offs come up
   where they matter, with the question a senior would ask in review ("what happens when this is retried?",
   "what if the disk fills?", "how would you know it broke?").
5. **Correct and current.** Facts, versions and APIs are right for today (2026). No deprecated APIs taught
   as current; when an old way is still common in real codebases, say so and show the modern one.
6. **See it before you memorise it.** The core mental model of each module has a picture: a diagram, a
   visualizer, a step-by-step trace, a builder or a lab. Learning should feel easy because it is visible.
7. **Hands-on and graded.** Code steps run real code against real tests; labs use real systems (containers,
   real CLIs) wherever that is possible on a laptop. Checks verify behaviour, not wording.
8. **Explain the why.** Every rule comes with the reason and the cost of ignoring it, so the learner can
   argue for it at work and apply it to cases the lesson did not cover.
9. **No gimmicks.** A step that does not teach something used at work is cut or replaced. Game elements
   reward real progress, never clicking.
10. **Interview-ready.** After a topic the learner can explain its key trade-offs out loud and solve the
    kind of problem asked about it in interviews.

## How a module is checked

- Does its boss (or final exercise) look like a real task from a job ticket?
- Is there a symptom-first debugging exercise?
- Is there a senior's toolkit card with real commands or APIs and their important flags?
- Is the central idea shown visually?
- Would a senior engineer reviewing the content find anything wrong, outdated or missing that they use
  weekly?

Content authors (people or agents) read this page before writing, and `tracks/AUTHORING.md` for the format.
