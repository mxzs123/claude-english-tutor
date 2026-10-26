# english-tutor

Practise English while you use Claude Code. Toggle with `/tutor`. When on, each prompt you send is reviewed by Haiku in the background, never blocking the agent: English prompts get corrections explained in Chinese plus a more natural rewrite; Chinese prompts get a natural English version, key words and a grammar note. Each call carries a bounded slice of context (two previous prompts, the tail of the last reply); `/tutor context off` sends the prompt alone.

Click an English word in the pane to hear it, spoken by Microsoft's neural voice (Andrew) through [edge-tts](https://github.com/rany2/edge-tts), which runs with `uvx`: install [uv](https://docs.astral.sh/uv/) for it. Click anywhere else on a block to ask about it: the feedback, or any answer under it. A field opens at the bottom of the card and Haiku answers there, seeing only the card and the thread leading to the chosen block (its last three questions). Esc returns to the prompt; an empty field closes with your next prompt.

Only prompts you type yourself are reviewed (not a `/loop`, a task's notification or a `claude -p` run), and nothing about the tutor reaches the agent's conversation: even `/tutor` is blanked there. A paste too long to review is left out, and the words typed around it are reviewed alone. In a terminal too narrow to show the pane unasked, prompts are still reviewed: open it with `/tutor` or the button above the prompt to read them.

Each review and follow-up, with Haiku's reply and token use, is written to `~/.claude/english-tutor/log/<date>.jsonl` on your machine, a file a day. A word you click is sent to Microsoft's speech service once and its audio kept in `~/.claude/english-tutor/audio/`. Nothing else is written, and the Haiku calls go through your own Claude Code session.

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
