# Oldest Chat Cleaner

A Violentmonkey userscript for reviewing and deleting the oldest chats in ChatGPT and Claude.

## Install

1. Install Violentmonkey in your browser.
2. Open the [userscript install link](https://raw.githubusercontent.com/mongkokman91/oldest-chat-cleaner/main/oldest-chat-cleaner.user.js).
3. Approve the installation once.

The userscript contains `@updateURL` and `@downloadURL` metadata pointing to this repository. Violentmonkey can therefore check GitHub for newer versions without requiring the script to be copied and pasted again.

To be prompted before updates are installed, enable update notifications or disable silent automatic updates in Violentmonkey's settings. The exact label can vary by Violentmonkey version.

## Current behavior

- Shows regular chats separately from project chats.
- Loads a project's chats only when its group is opened.
- Sorts eligible chats by creation date, oldest first.
- Uses a default batch size of 25.
- Attempts to identify pinned ChatGPT chats from the visible sidebar and protects them.
- Stops after the selected batch and waits for the user.
- Allows an active deletion run to be stopped or continued in the background.
- Uses bounded concurrency and retry/backoff for transient failures.

## Important limitations

This script relies on undocumented ChatGPT and Claude web endpoints. Those endpoints can change without notice. Always review the displayed chat titles before deleting anything.

Deleted chats may be unrecoverable. Do not use this script on chats you have not reviewed.

## Updating

For each published change, the `@version` value must be increased. Violentmonkey compares that value with the installed copy when checking for updates.
