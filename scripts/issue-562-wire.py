from pathlib import Path

path = Path("src/index-interactive.ts")
text = path.read_text()
old = '''      client: {\n        sendMessage: (chatId, text) => client.sendMessage({ chat_id: chatId, text }),\n      },\n    })'''
new = '''      client: {\n        sendMessage: (chatId, text) => client.sendMessage({ chat_id: chatId, text }),\n      },\n      recordDeliveredAssistantTurn: (chatKey, text) => {\n        db.addConvTurn(chatKey, "assistant", text);\n      },\n    })'''
if text.count(old) != 1:
    raise SystemExit(f"expected one owner notification ingress wiring block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
