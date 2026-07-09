import { useState, useEffect, useRef } from "react";
import socket from "../socket";
import Quiz from "./quiz";

const isValidRoomCode = (code) => /^\d{6}$/.test(code.trim());
const PLAYER_SESSION_KEY = "kbc-player-session";
const PLAYER_TOKEN_KEY = "kbc-player-token";

const readStoredSession = () => {
  try {
    const raw = localStorage.getItem(PLAYER_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStoredSession = (session) => {
  localStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(session));
};

const clearStoredSession = () => {
  localStorage.removeItem(PLAYER_SESSION_KEY);
};

const getOrCreatePlayerToken = () => {
  const existing = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (existing) return existing;

  const nextToken =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  localStorage.setItem(PLAYER_TOKEN_KEY, nextToken);
  return nextToken;
};

function Player({ quizStarted, quizSync }) {
  const [playerToken] = useState(getOrCreatePlayerToken);
  const pendingJoinRef = useRef(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [initialSync, setInitialSync] = useState(null);
  const [roomStarted, setRoomStarted] = useState(false);
  const [error, setError] = useState("");
  const [kickedMessage, setKickedMessage] = useState("");
  const [hostGone, setHostGone] = useState(false);
  const [waitingMessage, setWaitingMessage] = useState(
    "Waiting for host to start the quiz..."
  );

  useEffect(() => {
    const session = readStoredSession();
    if (!session) return;

    if (session.name) setName(session.name);
    if (session.roomCode) setCode(session.roomCode);
  }, []);

  useEffect(() => {
    const resumeSession = () => {
      const session = readStoredSession();
      if (!session?.roomCode || !session?.name || !session?.joined) return;
      if (joined || joining) return;
      if (!isValidRoomCode(session.roomCode)) return;

      setName(session.name);
      setCode(session.roomCode);
      setError("");
      setKickedMessage("");
      setHostGone(false);
      setJoining(true);

      socket.emit("join-room", {
        roomCode: session.roomCode,
        name: session.name,
        playerToken,
      });
    };

    const handlePendingJoin = () => {
      if (!pendingJoinRef.current || joined) return;

      const pending = pendingJoinRef.current;
      pendingJoinRef.current = null;
      socket.emit("join-room", pending);
    };

    const onConnectError = (err) => {
      if (!joined) {
        setJoining(false);
      }
      pendingJoinRef.current = null;
      setError(`Cannot reach quiz server: ${err?.message || "connection failed"}`);
    };

    const onDisconnect = () => {
      if (!joined) {
        setJoining(false);
        setError("Disconnected from quiz server. Check the server and try again.");
      }
    };

    socket.on("connect", resumeSession);
    socket.on("connect", handlePendingJoin);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);
    resumeSession();

    return () => {
      socket.off("connect", resumeSession);
      socket.off("connect", handlePendingJoin);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
    };
  }, [joined, joining, playerToken]);

  useEffect(() => {
    const onJoinError = (msg) => {
      setError(msg);
      setJoined(false);
      setJoining(false);
      clearStoredSession();
    };

    const onJoinSuccess = ({
      roomCode: joinedRoom,
      name: joinedName,
      quizStarted: started,
      quizSync: joinedSync,
      playerId,
      resumed,
    }) => {
      setJoined(true);
      setRoomCode(joinedRoom);
      setRoomStarted(!!started);
      setInitialSync(joinedSync ?? quizSync ?? null);
      setError("");
      setJoining(false);

      if (playerId && playerId !== playerToken) {
        localStorage.setItem(PLAYER_TOKEN_KEY, playerId);
      }

      writeStoredSession({
        roomCode: joinedRoom,
        name: joinedName,
        joined: true,
        resumed: !!resumed,
      });
    };

    const onKicked = ({ message }) => {
      setJoined(false);
      setJoining(false);
      setKickedMessage(message);
      setRoomCode("");
      clearStoredSession();
    };

    const onHostDisconnected = ({ message }) => {
      setJoined(false);
      setJoining(false);
      setHostGone(true);
      setError(message);
      clearStoredSession();
    };

    const onQuizReset = () => {
      setWaitingMessage("Host started a new quiz. Waiting to begin...");
      setRoomStarted(false);
      setInitialSync(null);
    };

    const onPlayerDisconnected = () => {
      if (!joined) return;
      setError("Connection lost. Reconnecting...");
    };

    socket.on("join-error", onJoinError);
    socket.on("join-success", onJoinSuccess);
    socket.on("kicked", onKicked);
    socket.on("host-disconnected", onHostDisconnected);
    socket.on("quiz-reset", onQuizReset);
    socket.on("player-disconnected", onPlayerDisconnected);

    return () => {
      socket.off("join-error", onJoinError);
      socket.off("join-success", onJoinSuccess);
      socket.off("kicked", onKicked);
      socket.off("host-disconnected", onHostDisconnected);
      socket.off("quiz-reset", onQuizReset);
      socket.off("player-disconnected", onPlayerDisconnected);
    };
  }, [joined, playerToken, quizSync]);

  const joinRoom = () => {
    const trimmedName = name.trim();
    const trimmedCode = code.trim();

    if (!trimmedName) {
      setError("Enter your name to join.");
      return;
    }

    if (!isValidRoomCode(trimmedCode)) {
      setError("Invalid room code. Enter the 6-digit code from your host.");
      return;
    }

    setError("");
    setKickedMessage("");
    setHostGone(false);
    setJoining(true);

    const joinPayload = {
      roomCode: trimmedCode,
      name: trimmedName,
      playerToken,
    };

    if (socket.connected) {
      socket.emit("join-room", joinPayload);
      return;
    }

    pendingJoinRef.current = joinPayload;
    setError("Connecting to quiz server...");
    socket.connect();
  };

  if (kickedMessage) {
    return (
      <div className="landing-screen">
        <h2>Removed from Quiz</h2>
        <p className="player-error">{kickedMessage}</p>
        <button
          type="button"
          onClick={() => {
            setKickedMessage("");
            setName("");
            setCode("");
            setError("");
            clearStoredSession();
          }}
        >
          Join Again
        </button>
      </div>
    );
  }

  if (hostGone) {
    return (
      <div className="landing-screen">
        <h2>Room Closed</h2>
        <p className="player-error">{error}</p>
      </div>
    );
  }

  if (joined && (quizStarted || roomStarted)) {
    return <Quiz roomCode={roomCode} playerName={name} initialSync={initialSync ?? quizSync} />;
  }

  if (joined && !quizStarted) {
    return (
      <div className="landing-screen">
        <h2>Welcome, {name}</h2>
        <p>Room: {roomCode}</p>
        <p>{waitingMessage}</p>
      </div>
    );
  }

  return (
    <div className="landing-screen">
      <h2>Join Quiz</h2>
      <p className="join-hint">
        Use the 6-digit room code from your host. Each name can only be used once per room.
      </p>

      <input
        placeholder="Your Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={joining}
      />
      <br /><br />

      <input
        placeholder="6-digit Room Code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        maxLength={6}
        disabled={joining}
      />
      <br /><br />

      {error && <p className="player-error">{error}</p>}

      <button type="button" onClick={joinRoom} disabled={joining}>
        {joining ? "Joining..." : "Join"}
      </button>
    </div>
  );
}

export default Player;
