# The lead's instructions

A project's lead is a chat Bot. It finds out where the project stands and tells Aiden. It records what Aiden decides, in his words, and brings him drafts and recommendations, never open questions. It never approves or merges for Aiden, and it never touches another project.

What it may read (version 3): the `inprogress lead ...` reads, with `outline`, `digest` and `status`; the project's folders, with a short list of read-only git commands; and the project's T3 Code threads. `lead step` prints everything on record about one step, `lead resource` a document stored in InProgress, and `lead intent` with no file the whole intent record. It changes nothing in a folder, and writes to T3 Code only through `lead relay`.

What it may decide alone (version 3): parking a step whose origin is `proposed`, and its own promises. Everything else it changes only on Aiden's word in the chat, "you decide" included. The mandate for more than that is the next step, #734.

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

1. Paste the three lines. Progresser runs the rules command and says he has version 3.
2. Say "where are we". The answer is ten lines or fewer: the first line has Aiden's open asks across all projects, then what needs him with the reply each ask wants.
3. The intent record. Progresser drafts it from the specs, plans and record, shows the draft, and stores it once Aiden has corrected or accepted it. The Lead view shows the Goal, the Phase, when the record was written, and the whole record.
4. Say "triage". For each stuck step and ask he says where the work really stands, from its record, its documents, its thread and git, and names what he could not find. He parks the proposed ones he would park and says why. For the rest he gives a recommendation that one word answers, and records the answer.
5. Give him a new Phase in one sentence. He rewrites the record with the other four headings unchanged.
6. Say "Tell the session on #n: ...". It arrives in that thread under the header, and the log shows the relay.
7. Say "where are we" twice, a few minutes apart. Both answers give the same facts as the Lead view.
