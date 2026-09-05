# Telegram topic workstreams

Telegram forum topics do not need separate Agent Bridge configuration. The interactive runtime resolves each topic to its own canonical conversation key while retaining the group chat ID and topic thread ID as delivery coordinates.

Conceptually:

```text
Telegram supergroup + forum topic
        ↓
canonical workstream key
        ↓
history, Runs, queue, provider preference, sessions
        ↓
Telegram delivery using chat ID + message_thread_id
```

A topic is a workstream, not a provider binding. You can switch from Codex to Claude Code, Antigravity/Agy, Grok Build, or Cursor while keeping the same workstream.

## 1. Configure the interactive bot

Use the [Telegram multi-provider example](telegram-multi-provider.md), then add that bot to a Telegram supergroup with Topics enabled. Ensure the bot is permitted to receive the messages you expect it to handle.

Start the runtime:

```bash
npm start
```

## 2. Work in separate topics

Create two topics in the same group, for example `Platform` and `OSS`, and message the bot from each.

Agent Bridge resolves them independently. A group with native chat ID `-1001234567890` and topic IDs `100` and `200` is represented internally as two distinct workstream keys:

```text
-1001234567890:100
-1001234567890:200
```

The group root conversation remains distinct from both topic workstreams.

## 3. Use controls inside the topic

Run `/cli`, `/stop`, or `/reset` from the topic where you want the action to apply. Provider selection, retained conversation state, queue/cancellation scope, and provider-native sessions remain attached to that topic's canonical workstream rather than being shared merely because two topics live in the same Telegram group.

Replies and progress delivery preserve the original `message_thread_id`, so the result returns to the same topic.
