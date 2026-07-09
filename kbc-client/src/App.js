import { useState, useEffect } from "react";
import Admin from "./components/admin";
import Quiz from "./components/quiz";
import Player from "./components/player";
import socket from "./socket";
import AdminDashboard from "./components/admindashboard";
import AdminLogin from "./components/admin-login";

function App() {
  const [role, setRole] = useState(null);
  const [roomCode, setRoomCode] = useState("");
  const [quizStarted, setQuizStarted] = useState(false);
  const [quizSync, setQuizSync] = useState(null);

  const [isAdmin, setIsAdmin] = useState(
    sessionStorage.getItem("isAdmin") === "true"
  );

  // Clear stale host lock from old sessions or crashed tabs
  useEffect(() => {
    if (sessionStorage.getItem("isAdmin") !== "true") {
      localStorage.removeItem("adminActive");
    }
  }, []);

  useEffect(() => {
    socket.connect();

    socket.on("connect", () => {
      console.log("Connected to server:", socket.id);
    });

    socket.on("room-created", ({ roomCode: code }) => {
      socket.roomCode = code;
      setRoomCode(code);
    });

    socket.on("quiz-started", (payload) => {
      setQuizStarted(true);
      setQuizSync(payload?.quizSync ?? null);
    });

    socket.on("quiz-reset", () => {
      setQuizStarted(false);
      setQuizSync(null);
    });

    return () => {
      socket.off("connect");
      socket.off("room-created");
      socket.off("quiz-started");
      socket.off("quiz-reset");
    };
  }, []);

  useEffect(() => {
    const handleUnload = () => {
      if (role === "admin") {
        localStorage.removeItem("adminActive");
      }
    };

    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [role]);

  useEffect(() => {
    if (role === "admin" && roomCode === "") {
      socket.emit("create-room");
    }
  }, [role, roomCode]);

  if (!role) {
    return (
      <div className="landing-screen">
        <h2>KBC Quiz</h2>
        <p>Offline multiplayer — host controls everything.</p>
        <div className="landing-actions">
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem("adminActive");
              localStorage.setItem("adminActive", String(Date.now()));
              setRole("admin");
            }}
          >
            Host
          </button>
          <button type="button" onClick={() => setRole("player")}>
            Player
          </button>
        </div>
      </div>
    );
  }

  if (role === "admin") {
    if (!isAdmin) {
      return <AdminLogin onSuccess={() => setIsAdmin(true)} />;
    }

    return (
      <>
        <Admin roomCode={roomCode} />
        <AdminDashboard />
      </>
    );
  }

  if (role === "player") {
    return <Player quizStarted={quizStarted} quizSync={quizSync} />;
  }

  return null;
}

export default App;
