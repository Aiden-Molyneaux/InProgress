# Close open working tasks on done (#317): rulings

Decisions taken on Aiden's behalf while building #317. Format: decision, why, what it costs if wrong. Review these and
rework anything ruled wrongly.

1. Only a step going to done ticks its open working tasks. A dropped step leaves them as they are: `completed` would
   say the work was finished when it was abandoned, and the trail and Details would show it ticked. The step's
   dropped status already tells the reader the tasks are moot. Cost if wrong: a dropped step keeps counting toward a
   session's "N open tasks" in the digest; adding `dropped` is a one-line change in `patchNode`.
2. Close means set to `completed`, not delete, for every row on the step whoever owns it, and only on the transition
   into done (Orchestrator, session I; recorded here so the ruling lives in one place). Cost if wrong: the trail keeps
   rows Aiden would rather not see.
3. #398, both guards (session L). `taskUpdated` keeps a `completed` row on a done step `completed` when an update
   moves it back to `pending` or `in_progress`; subject and blocks changes still land, and the guard lifts when the
   step reopens. `attribute()` skips a subagent node or focus that is done or dropped, so a new task falls through to
   the project root. Each closes a gap the other leaves: the first covers rows that exist, the second new ones. Cost
   if wrong: a session that really does more work on a done step loses its status changes there until the step is
   reopened.
4. A leading `#id` still wins even when it names a done or dropped step (session L): naming a step is deliberate,
   and such a task is open on the step until it is next marked done. Cost if wrong: stray open tasks on finished
   steps, which the Orchestrator's reconcile already lists.
