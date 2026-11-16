# The lead's instructions

A project's lead is a chat Bot. It reads where the project stands and tells Aiden. It records what Aiden decides, in his words. It can run only `inprogress lead ...` commands, plus `outline`, `digest` and `status` to read. It never approves, merges or decides for Aiden. It never touches another project, git, files or T3 Code except through `lead relay`.

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

1. Paste the three lines. Progresser runs the rules command and says he has version 2.
2. Say "where are we". The answer is ten lines or fewer: the first line has Aiden's open asks across all projects, then what needs him with the reply each ask wants.
3. Talk through the five headings of the intent record. Progresser writes it, and the Lead view shows the Goal and the Phase.
4. For the first triage, say keep, park or drop for each stuck step and each ask. It is recorded.
5. Say "Tell the session on #n: ...". It arrives in that thread under the header, and the log shows the relay.
6. Say "where are we" twice, a few minutes apart. Both answers give the same facts as the Lead view.
