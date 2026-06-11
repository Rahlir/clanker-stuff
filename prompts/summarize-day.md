---
description: Summarize my day in daily note
---
Your task is to write a short summary of what I have done today to my daily
note.

The steps you should follow:

1. Create or find daily note. Daily notes are handled with `zk`. Run `zk new
   --no-input -p daily`. This will print an absolute path to the daily note.
   This commands also creates this note if it hadn't existed yet. Note that you
   should never rewrite this note - it has a shape according to a specific
   template and we want to maintain this shape.
2. Analyze, what I was doing today. The primary source for that are the `pi`
   session logs. These can be found at `~/.pi/agent/sessions`. They are then
   split according to the directory where they were started. Find session logs
   that were created today or contain entries from today. This should provide
   you with the main context of what work was done today.
3. Next, check the directories where I ran `pi` sessions today (you will have
   this info from step 2). It is possible that I did some work there without
   AI. To get that context, check those directories and if they are git repos,
   read the git history: `git log --since yesterday`.
4. Check few notes from the notes directory (`$ZK_NOTEBOOK_DIR`). The summary
   should be written in the same tone and style as other notes in this
   directory. **The summary you write has to look as if I have written it
   myself**. Your task is to match my style of writing. So gather the necessary
   context for that at this step.
5. Now you are ready to write the note itself. Edit the file you have found in
   step 1. Append a new section to the daily note with the heading "###
   Summary". There, write what I have been doing today. At the end of the note
   summary section, append the following disclaimer:
   ```text
    > [!NOTE]
    > The above summary was generated with AI mostly based on `pi` session logs. Don't treat it as an authoritative source, it might be incomplete or inaccurate.
   ```
6. Show me the summary for review and ask me if I want to change anything. Sync
   the notes repository only after we have iterated on your draft or I have
   approved your summary.
