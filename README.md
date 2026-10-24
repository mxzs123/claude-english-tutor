# english-tutor

Practise English while you use Claude Code. Toggle with `/tutor`. When on, each prompt you send is reviewed by Haiku in the background, never blocking the agent: English prompts get corrections explained in Chinese plus a more natural rewrite; Chinese prompts get a natural English version, key words and a grammar note. Each call carries a bounded slice of context (two previous prompts, the tail of the last reply); `/tutor context off` sends the prompt alone.

Click a block in the pane to ask about it: the feedback, or any answer under it. A field opens at the bottom of the card and Haiku answers there, seeing only the card and the thread leading to the chosen block (its last three questions). Esc returns to the prompt; an empty field closes with your next prompt.

Each review and follow-up, with Haiku's reply and token use, is appended to `~/.claude/english-tutor/log.jsonl` on your machine (its last 1000 lines are kept). Nothing else is written, and the calls go through your own Claude Code session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install english-tutor --marketplace mxzs123/claude-english-tutor
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install english-tutor --marketplace mxzs123/claude-english-tutor
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `mxzs123/claude-english-tutor`, then Add plugin.

The pane docks beside the transcript in the fullscreen terminal; clicking a block to ask about it needs that layout.
