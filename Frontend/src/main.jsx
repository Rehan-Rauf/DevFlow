import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./styles/auth.css";
import "./styles/ui.css";
import "./styles/responsive.css";
import "./styles/base.css";
import "./styles/ai-memory.css";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import "./styles/workspace.css";


ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
