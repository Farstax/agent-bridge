from pathlib import Path
import subprocess, sys

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "implementation":
    path = Path("src/engine.ts")
    text = path.read_text()
    text = text.replace('import { MediaGroupBuffer } from "./telegram.js";', 'import { TelegramClient, MediaGroupBuffer } from "./telegram.js";', 1)
    text = text.replace('import { PreviewCleanupError, sendTelegramMessage, sendMessageWithProgress } from "./messageDelivery.js";', 'import { sendTelegramMessage, sendMessageWithProgress, PreviewCleanupError } from "./messageDelivery.js";', 1)
    path.write_text(text)

subprocess.check_call(["python3", "scripts/issue-605-transform-v2.py", mode])

if mode == "implementation":
    path = Path("src/engine.ts")
    text = path.read_text().replace('import { TelegramClient } from "./telegram.js";\n', '')
    path.write_text(text)
