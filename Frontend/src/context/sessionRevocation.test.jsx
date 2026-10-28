import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "./AuthContext";
import ProtectedRoute from "../components/ProtectedRoute";
import { api } from "../services/api";

vi.mock("../services/api", () => ({
  api: {
    me: vi.fn(),
    logout: vi.fn(),
    login: vi.fn(),
    signup: vi.fn(),
    acceptInvitationAndCreateAccount: vi.fn(),
  },
}));

describe("session revocation", () => {
  test("removes stale auth when the backend rejects /me", async () => {
    api.me.mockRejectedValue(new Error("expired"));
    localStorage.setItem("cms_token", "expired-token");

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={["/overview"]}>
          <Routes>
            <Route path="/overview" element={<ProtectedRoute><div>protected</div></ProtectedRoute>} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => expect(localStorage.getItem("cms_token")).toBeNull());
    await waitFor(() => expect(screen.getByText("login page")).toBeTruthy());
  });
});
