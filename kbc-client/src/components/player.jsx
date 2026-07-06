import { useState, useEffect } from "react";
import socket from "../socket";
import Quiz from "./quiz";

const isValidRoomCode = (code) => /^\d{6}$/.test(code.trim());

function Player({ quizStarted, quizSync }) {
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
    const onJoinError = (msg) => {
      setError(msg);
      setJoined(false);
      setJoining(false);
    };

    const onJoinSuccess = ({ roomCode: joinedRoom, quizStarted: started, quizSync: joinedSync }) => {
      setJoined(true);
      setRoomCode(joinedRoom);
      setRoomStarted(!!started);
      setInitialSync(joinedSync ?? quizSync ?? null);
      setError("");
      setJoining(false);
    };

    const onKicked = ({ message }) => {
      setJoined(false);
      setJoining(false);
      setKickedMessage(message);
      setRoomCode("");
    };

    const onHostDisconnected = ({ message }) => {
      setJoined(false);
      setJoining(false);
      setHostGone(true);
      setError(message);
    };

    const onQuizReset = () => {
      setWaitingMessage("Host started a new quiz. Waiting to begin...");
      setRoomStarted(false);
      setInitialSync(null);
    };

    socket.on("join-error", onJoinError);
    socket.on("join-success", onJoinSuccess);
    socket.on("kicked", onKicked);
    socket.on("host-disconnected", onHostDisconnected);
    socket.on("quiz-reset", onQuizReset);

    return () => {
      socket.off("join-error", onJoinError);
      socket.off("join-success", onJoinSuccess);
      socket.off("kicked", onKicked);
      socket.off("host-disconnected", onHostDisconnected);
      socket.off("quiz-reset", onQuizReset);
    };
  }, []);

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

    socket.emit("join-room", {
      roomCode: trimmedCode,
      name: trimmedName,
    });
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
