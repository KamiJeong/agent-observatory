import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("Agent Observatory brand assets", () => {
  it("wires a contrast-aware SVG favicon and decorative header mark", () => {
    const indexHtml = readFileSync(`${repositoryRoot}/apps/web/index.html`, "utf8");
    const dashboard = readFileSync(
      `${repositoryRoot}/apps/web/src/components/dashboard/DashboardApp.tsx`,
      "utf8",
    );
    const styles = readFileSync(`${repositoryRoot}/apps/web/src/styles.css`, "utf8");
    const logo = readFileSync(`${repositoryRoot}/apps/web/public/agent-observatory.svg`, "utf8");

    expect(indexHtml).toContain('<link rel="icon" href="/agent-observatory.svg" type="image/svg+xml" />');
    expect(dashboard).toContain('<span className="brand__mark" aria-hidden="true" />');
    expect(dashboard).not.toContain("⌁");
    expect(styles).toContain('mask: url("/agent-observatory.svg") center / contain no-repeat');
    expect(logo).toContain('viewBox="0 0 1254 1254"');
    expect(logo).toContain('fill-rule="evenodd"');
    expect(logo).toContain("prefers-color-scheme: dark");
  });
});
