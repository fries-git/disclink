// disclinkextension.js
(function (Scratch) {
  const wsUrl = "ws://localhost:3000";
  let socket;
  let lastMessage = null;
  let lastPing = null;

  function connect() {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log("[Extension] Connected to server");
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "message") {
          lastMessage = data;
        } else if (data.type === "ping") {
          lastPing = data;
        }
      } catch (e) {
        console.error("[Extension] Bad payload:", e);
      }
    };

    socket.onclose = () => {
      console.log("[Extension] Disconnected, retrying...");
      setTimeout(connect, 2000);
    };
  }

  connect();

  class DiscordBridge {
    getInfo() {
      return {
        id: "discordbridge",
        name: "Discord Bridge",
        blocks: [
          {
            opcode: "onMessage",
            blockType: Scratch.BlockType.HAT,
            text: "when message received",
          },
          {
            opcode: "getMessage",
            blockType: Scratch.BlockType.REPORTER,
            text: "message content",
          },
          {
            opcode: "getMessageMeta",
            blockType: Scratch.BlockType.REPORTER,
            text: "message [FIELD]",
            arguments: {
              FIELD: {
                type: Scratch.ArgumentType.STRING,
                menu: "msgFields",
              },
            },
          },
          "---",
          {
            opcode: "onPing",
            blockType: Scratch.BlockType.HAT,
            text: "when ping received",
          },
          {
            opcode: "getPingMeta",
            blockType: Scratch.BlockType.REPORTER,
            text: "ping [FIELD]",
            arguments: {
              FIELD: {
                type: Scratch.ArgumentType.STRING,
                menu: "pingFields",
              },
            },
          },
          "---",
          {
            opcode: "sendMessage",
            blockType: Scratch.BlockType.COMMAND,
            text: "send [TEXT] to [CHANNEL] in [SERVER]",
            arguments: {
              TEXT: { type: Scratch.ArgumentType.STRING, defaultValue: "Hello!" },
              CHANNEL: { type: Scratch.ArgumentType.STRING, defaultValue: "general" },
              SERVER: { type: Scratch.ArgumentType.STRING, defaultValue: "My Server" },
            },
          },
        ],
        menus: {
          msgFields: {
            acceptReporters: true,
            items: ["author", "channel", "server", "timestamp", "media"],
          },
          pingFields: {
            acceptReporters: true,
            items: ["from", "channel", "server", "timestamp", "content"],
          },
        },
      };
    }

    // HAT triggers
    onMessage() {
      return lastMessage !== null;
    }

    onPing() {
      return lastPing !== null;
    }

    // Reporters
    getMessage() {
      return lastMessage?.content || "";
    }

    getMessageMeta(args) {
      if (!lastMessage) return "";
      return lastMessage[args.FIELD] ?? "";
    }

    getPingMeta(args) {
      if (!lastPing) return "";
      return lastPing[args.FIELD] ?? "";
    }

    // Command
    sendMessage(args) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const payload = {
        type: "sendMessage",
        content: args.TEXT,
        channel: args.CHANNEL,
        server: args.SERVER,
      };
      socket.send(JSON.stringify(payload));
    }
  }

  Scratch.extensions.register(new DiscordBridge());
})(Scratch);
