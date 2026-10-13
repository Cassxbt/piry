import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SiteLink } from "../components/site/SiteLink";
import { CountUp } from "../components/site/motion";
import { MotionProvider } from "../components/site/motion";
import { trimmed } from "../lib/numbers";

beforeAll(() => {
  // jsdom has no IntersectionObserver; every browser the app targets does.
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
});

afterEach(cleanup);

describe("SiteLink", () => {
  it("keeps ?network and ?series across pages and drops everything else", () => {
    render(
      <MemoryRouter initialEntries={["/app?network=local&series=fast-demo&utm=x"]}>
        <SiteLink to="/evidence">Evidence</SiteLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Evidence" }).getAttribute("href")).toBe("/evidence?network=local&series=fast-demo");
  });

  it("carries a hash to the target page", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SiteLink to="/app" hash="exposure">Size</SiteLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Size" }).getAttribute("href")).toBe("/app#exposure");
  });

  it("marks the current page for assistive tech when used as navigation", () => {
    render(
      <MemoryRouter initialEntries={["/market"]}>
        <SiteLink to="/market" nav>Market</SiteLink>
        <SiteLink to="/roadmap" nav>Roadmap</SiteLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Market" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Roadmap" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("CountUp", () => {
  it("shows n/a for a missing value instead of a placeholder number", () => {
    render(<MotionProvider><CountUp value={null} format={(n) => `$${n}`} /></MotionProvider>);
    expect(screen.getByText("n/a")).toBeTruthy();
  });
});

describe("trimmed", () => {
  it("trims trailing zeros down to a minimum number of decimals", () => {
    expect(trimmed(3.3885, 2, 6)).toBe("3.3885");
    expect(trimmed(2.5, 2, 6)).toBe("2.50");
    expect(trimmed(4, 0, 2)).toBe("4");
    expect(trimmed(0.44425, 4, 6)).toBe("0.44425");
  });
});
