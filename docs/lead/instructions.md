# The lead's instructions

A project's lead is a chat Bot. It finds out where the project stands and tells Aiden. It records what Aiden decides, in his words, and brings him drafts and recommendations, never open questions. It never approves or merges for Aiden, and it never touches another project.

What it may read (version 3): the `inprogress lead ...` reads, with `outline`, `digest` and `status`; the project's folders, with a short list of read-only git commands; and the project's T3 Code threads. `lead step` prints everything on record about one step, `lead resource` a document stored in InProgress, and `lead intent` with no file the whole intent record. It changes nothing in a folder, and writes to T3 Code only through `lead relay`.

What it may decide alone (version 4): what its mandate allows. The rule is one line: if Aiden can undo it in one word and nothing is lost in the meantime, the lead decides and tells him afterwards; if not, it is Aiden's, and it reaches him with a recommendation one word accepts. So the lead answers a session's question with `lead decide`, and parks a step nobody is working on with `lead park --reason`. A permission, a review, a merge, a deploy, a push, a change of direction and anything Aiden would see or feel stay his.

Every decision gets a number (`d12`). The brief and the Lead view list the last 7 days of them, each with its reason, and Aiden puts one back by saying "undo d12": the lead runs `lead undo` with his words, a parked or dropped step returns, and a decided question becomes his again as a new ask.

The mandate binds sessions too. In a project with a lead the session briefing carries it in two lines: a session decides what can be undone, records the call as a step log that starts `Decided for Aiden:`, and carries on. Those logs are in the same list.

What it may do (version 5): start a thread. `lead start <project> <step>` opens a T3 Code thread in the project's folder with a handoff (the step's What and Why, the Goal and the Phase, "Run this through Sigmund"). It is refused for a step that is finished, parked, already being worked on or missing its What and Why, for a project with no intent record or no folder, and past the limits: 3 sessions in flight per project, and on the lead's own judgment 3 starts in 24 hours and none while 5 asks wait on Aiden.

Two switches per project decide what happens without Aiden's word. Both are off until he turns them on, and only his words turn one on (`lead allow <project> starts|landing --aiden "<his words>"`); the brief and the Lead view show each switch, since when, and those words. **Starts** on: the lead may start the next step inside the Phase himself. Off: he starts one only on Aiden's word. **Landing** on: the session briefing carries a Landing line, and a session lands work itself when nothing in its bar shows on a screen, its diff touches nothing on the risk list, the checks are green, the reviewer's verdict is sound and the deploy is green; it records the landing as `Decided for Aiden: landed <sha>`. Off: every landing waits for him. A switch is not a column: its state is the newest `allow` or `disallow` line in the lead's log.

The mandate is code: `src/core/lead-mandate.ts`. A lead cannot widen it. A question a lead has not decided stays Aiden's in the data, so with the Bot off he still sees it and answers it in the window.

## How the rules reach it

The rules are not pasted. The lead fetches them with a command:

    lead rules <project> --as <name>

It prints the rules for that lead on that project: version, name, the project, the full command prefix and every command, the rules command itself first among the reads. A name that is not the project's lead is refused with the no-lead sentence, and an archived project is refused with its own sentence (it has no lead).

A lead's name is one plain word: 1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or a digit. The rules print it unquoted on every command line, so Aiden cannot give a lead any other name. The command needs no `--instructions`, because the lead does not know the version until it has read the rules.

Every other lead command carries `--instructions <n>`, the version the lead read. The current version is `LEAD_INSTRUCTIONS_VERSION` in `src/core/lead.ts`. A lead on an older version can still read (`lead brief` answers, and its second line says the rules are out of date) but cannot change anything: a change is refused with a sentence that tells it to run the rules command again. Bumping the constant is how a rule change reaches every lead with a deploy.

## The three lines to paste

Paste these into the Bot once. The command that prints them for a project is:

    lead rules inprogress --as Progresser --bootstrap

They read:

    You are Progresser, the lead for InProgress.
    Before anything else in every conversation, run this on Aiden's laptop and follow exactly what it prints:
    node <path to this checkout>/dist/cli/main.js lead rules inprogress --as Progresser

## Where the text lives

The rules and the three lines are code: `src/core/lead-rules.ts`. The built server carries them, and `test/core/lead-rules.test.ts` pins every line. This file does not repeat the rules. Change the text there, bump the version if a lead on old rules should stop changing things, and deploy.

## The acceptance run

Run in Grok after the gate, in a new conversation:

1. Paste the three lines. Progresser runs the rules command and says he has version 6.
1b. Version 6: say "show me the picture r<n> on step <n>" for a picture attached to a step. He finds the document with lead step, copies its file from the laptop to his own computer, and the picture appears in the chat. Grok's file tools copy only from inside the user folder (`C:\Users\<user>`), which is where a step's documents are kept; a picture inside the project's folders cannot be shown.
1a. Say "start #n" for a step that is next. A thread opens in T3 Code, claims the step within a minute, and the brief lists it under Started. Say "turn starts on" and later "where are we": he says what he started himself, and why.
2. Say "where are we". He first decides the open questions his mandate lets him decide. The answer is twelve lines or fewer: the first line has Aiden's open asks across all projects, then what was decided for him with the words that undo each, then what needs him, each with a recommendation one word answers.
2a. Say "undo d<n>" for one of them. It is put back, and he says what InProgress answered.
2b. Start a new session on a step. It decides routine calls itself, records them as "Decided for Aiden:", and asks only what is Aiden's.
3. The intent record. Progresser drafts it from the specs, plans and record, shows the draft, and stores it once Aiden has corrected or accepted it. The Lead view shows the Goal, the Phase, when the record was written, and the whole record.
4. Say "triage". For each stuck step and ask he says where the work really stands, from its record, its documents, its thread and git, and names what he could not find. He parks the proposed ones he would park and says why. For the rest he gives a recommendation that one word answers, and records the answer.
5. Give him a new Phase in one sentence. He rewrites the record with the other four headings unchanged.
6. Say "Tell the session on #n: ...". It arrives in that thread under the header, and the log shows the relay.
7. Say "where are we" twice, a few minutes apart. Both answers give the same facts as the Lead view.
