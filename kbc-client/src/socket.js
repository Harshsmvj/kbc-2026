import { io } from "socket.io-client";

const getDefaultSocketUrl = () => {
  if (typeof window === "undefined") {
    return "http://localhost:5000";
  }

  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:5000`;
};

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || getDefaultSocketUrl();

const socket = io(SOCKET_URL, {
  autoConnect: false,
  transports: ["websocket", "polling"],
  upgrade: true,
});

export default socket;
