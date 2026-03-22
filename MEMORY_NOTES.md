 # Persistent Memory

Added persistent memory to the bot using memory.json.
Chat history now survives bot restarts.

## How it works
- On startup: loads memory.json
- After each message: saves to memory.json  
- /clear command: wipes memory.json
- /memory command: shows memory status
