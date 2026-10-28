import "@testing-library/jest-dom/vitest";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
