import { useState } from "react";
import socket from "../socket";

function AdminLogin({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    setError("");

    const trimmed = password.trim();
    if (!trimmed) {
      setError("Enter the admin password.");
      return;
    }

    if (!socket.connected) {
      setError(
        "Cannot reach server. Start it first: cd server → node index.js"
      );
      return;
    }

    setLoading(true);
    let responded = false;

    const onResult = ({ success, message }) => {
      if (responded) return;
      responded = true;
      socket.off("admin-login-result", onResult);
      setLoading(false);

      if (success) {
        sessionStorage.setItem("isAdmin", "true");
        onSuccess();
        return;
      }

      setError(message || "Wrong admin password.");
    };

    socket.on("admin-login-result", onResult);
    socket.emit("admin-login", { password: trimmed });

    setTimeout(() => {
      if (responded) return;
      responded = true;
      socket.off("admin-login-result", onResult);
      setLoading(false);
      setError("Server did not respond. Make sure it is running on port 5000.");
    }, 5000);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      handleLogin();
    }
  };

  return (
    <div className="landing-screen">
      <h2>Admin Login</h2>
      <p className="join-hint">Default password: kbc_admin_123</p>

      <input
        type="password"
        placeholder="Enter admin password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={loading}
      />

      <br /><br />

      <button type="button" onClick={handleLogin} disabled={loading}>
        {loading ? "Logging in..." : "Login"}
      </button>

      {error && <p className="player-error">{error}</p>}
    </div>
  );
}

export default AdminLogin;
