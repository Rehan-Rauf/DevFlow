import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { AuthProvider, useAuth } from "./AuthContext";
import ProtectedRoute from "../components/ProtectedRoute";
import { api } from "../services/api";

vi.mock("../services/api", () => ({
  api: {
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    signup: vi.fn(),
    acceptInvitationAndCreateAccount: vi.fn(),
  },
}));

function AuthHarness() {
  const { user, loading, login, logout } = useAuth();

  return (
    <div>
      <div>{loading ? "loading" : "ready"}</div>
      <div>{user ? `user:${user.name}` : "no-user"}</div>
      <button type="button" onClick={() => login({ email: "alice@example.com", password: "Password123!" })}>
        login
      </button>
      <button type="button" onClick={logout}>
        logout
      </button>
    </div>
  );
}

describe("AuthContext", () => {
  test("stores a JWT after login and populates the user state", async () => {
    api.login.mockResolvedValue({
      data: { token: "jwt-123", user: { id: 1, name: "Alice" } },
    });

    render(
      <AuthProvider>
        <AuthHarness />
      </AuthProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "login" }));

    await waitFor(() => expect(localStorage.getItem("cms_token")).toBe("jwt-123"));
    expect(screen.getByText("user:Alice")).toBeTruthy();
  });

  test("logout clears the stored token and user state", async () => {
    localStorage.setItem("cms_token", "jwt-123");
    api.me.mockResolvedValue({ data: { id: 1, name: "Alice" } });
    api.logout.mockResolvedValue({});

    render(
      <AuthProvider>
        <AuthHarness />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByText("user:Alice")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => expect(localStorage.getItem("cms_token")).toBeNull());
    expect(screen.getByText("no-user")).toBeTruthy();
  });

  test("redirects unauthenticated users to login", async () => {
    render(
      <MemoryRouter initialEntries={["/secure"]}>
        <Routes>
          <Route path="/secure" element={<ProtectedRoute><div>secret</div></ProtectedRoute>} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("login page")).toBeTruthy());
  });
});
