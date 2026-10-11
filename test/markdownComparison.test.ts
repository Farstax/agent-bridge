import { describe, it, expect } from "vitest";
import { CANDIDATE_PARSERS } from "../src/markdown/index.js";
import {
  renderTelegramHtml,
  renderTelegramRichHtml,
  renderDiscord,
  isSafeUrl,
  escapeHtml,
} from "../src/markdown/renderers.js";
import { MARKDOWN_SPIKE_FIXTURES } from "./fixtures/markdownSpikeFixtures.js";

describe("Markdown Parser Spike: Candidate Comparison", () => {
  const parsers = Object.entries(CANDIDATE_PARSERS);

  describe("1. Known Defect Reproduction (Loose Ordered Lists)", () => {
    const input = "1. First task\n\n1. Second task\n\n1. Third task";

    it("reproduces the restart defect in the current custom parser", () => {
      const custom = CANDIDATE_PARSERS["custom"];
      const ir = custom.parse(input);
      // The current parser splits into 3 separate lists because of the blank lines
      const listNodes = ir.filter((n) => n.type === "list");
      expect(listNodes.length).toBe(3);

      const html = renderTelegramHtml(ir);
      // In the current renderer, each restarts at 1
      expect(html).toContain("1. First task");
      expect(html).toContain("1. Second task");
      expect(html).toContain("1. Third task");
    });

    it("fixes the restart defect in Marked", () => {
      const marked = CANDIDATE_PARSERS["marked"];
      const ir = marked.parse(input);
      const listNodes = ir.filter((n) => n.type === "list");
      expect(listNodes.length).toBe(1);
      expect((listNodes[0] as any).items.length).toBe(3);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. First task");
      expect(html).toContain("2. Second task");
      expect(html).toContain("3. Third task");
    });

    it("fixes the restart defect in markdown-it", () => {
      const mdIt = CANDIDATE_PARSERS["markdown-it"];
      const ir = mdIt.parse(input);
      const listNodes = ir.filter((n) => n.type === "list");
      expect(listNodes.length).toBe(1);
      expect((listNodes[0] as any).items.length).toBe(3);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. First task");
      expect(html).toContain("2. Second task");
      expect(html).toContain("3. Third task");
    });

    it("fixes the restart defect in remark", () => {
      const remark = CANDIDATE_PARSERS["remark"];
      const ir = remark.parse(input);
      const listNodes = ir.filter((n) => n.type === "list");
      expect(listNodes.length).toBe(1);
      expect((listNodes[0] as any).items.length).toBe(3);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. First task");
      expect(html).toContain("2. Second task");
      expect(html).toContain("3. Third task");
    });
  });

  describe("2. Non-1 Starting Number Preservation", () => {
    const input = "5. Fifth item\n6. Sixth item\n7. Seventh item";

    it("current parser fails to preserve start number 5 (restarts at 1)", () => {
      const custom = CANDIDATE_PARSERS["custom"];
      const ir = custom.parse(input);
      const html = renderTelegramHtml(ir);
      // Current parser does not track start and renders 1. Fifth item
      expect(html).toContain("1. Fifth item");
    });

    it("Marked preserves start number 5", () => {
      const marked = CANDIDATE_PARSERS["marked"];
      const ir = marked.parse(input);
      const list = ir.find((n) => n.type === "list") as any;
      expect(list?.start).toBe(5);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("5. Fifth item");
      expect(html).toContain("6. Sixth item");
      expect(html).toContain("7. Seventh item");
    });

    it("markdown-it preserves start number 5", () => {
      const mdIt = CANDIDATE_PARSERS["markdown-it"];
      const ir = mdIt.parse(input);
      const list = ir.find((n) => n.type === "list") as any;
      expect(list?.start).toBe(5);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("5. Fifth item");
      expect(html).toContain("6. Sixth item");
      expect(html).toContain("7. Seventh item");
    });

    it("remark preserves start number 5", () => {
      const remark = CANDIDATE_PARSERS["remark"];
      const ir = remark.parse(input);
      const list = ir.find((n) => n.type === "list") as any;
      expect(list?.start).toBe(5);

      const html = renderTelegramHtml(ir);
      expect(html).toContain("5. Fifth item");
      expect(html).toContain("6. Sixth item");
      expect(html).toContain("7. Seventh item");
    });
  });

  describe("3. 12-Category Regression Fixture Verification", () => {
    for (const fixture of MARKDOWN_SPIKE_FIXTURES) {
      describe(`Fixture: ${fixture.title} (${fixture.id})`, () => {
        for (const [id, parser] of parsers) {
          it(`parses cleanly without exception using ${parser.name}`, () => {
            const ir = parser.parse(fixture.input);
            expect(Array.isArray(ir)).toBe(true);

            // Verify surface renderers run without throwing
            const tgHtml = renderTelegramHtml(ir);
            expect(typeof tgHtml).toBe("string");

            const tgRichHtml = renderTelegramRichHtml(ir);
            expect(typeof tgRichHtml).toBe("string");

            const discord = renderDiscord(ir);
            expect(typeof discord).toBe("string");
          });
        }
      });
    }
  });

  describe("4. Security and Sanitization", () => {
    it("escapes raw HTML script tags to prevent Telegram entity parsing errors", () => {
      const raw = "<script>alert(1)</script>";
      const markedIr = CANDIDATE_PARSERS["marked"].parse(raw);
      const html = renderTelegramHtml(markedIr);
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("neutralizes javascript: URIs in markdown links", () => {
      const raw = "[Attack](javascript:stealData())";
      const markedIr = CANDIDATE_PARSERS["marked"].parse(raw);
      const html = renderTelegramHtml(markedIr);
      expect(html).not.toContain('<a href="javascript:');
      expect(html).toContain("javascript:stealData()");
    });

    it("accepts safe https and tg URIs in markdown links", () => {
      expect(isSafeUrl("https://example.com")).toBe(true);
      expect(isSafeUrl("tg://user?id=123")).toBe(true);
      expect(isSafeUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeUrl("data:text/html,...")).toBe(false);
    });
  });

  describe("5. Real-World Five-Step Qualification Report", () => {
    const fixture = MARKDOWN_SPIKE_FIXTURES.find((f) => f.id === "real-world-five-step-qualification")!;

    it("reproduces broken 1, 1, 1, 1, 1 numbering on current parser", () => {
      const ir = CANDIDATE_PARSERS["custom"].parse(fixture.input);
      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. <b>Systemd Services</b>");
      expect(html).toContain("1. <b>Database Integrity</b>");
      expect(html).toContain("1. <b>Inward ACP Providers</b>");
      expect(html).toContain("1. <b>Surface Channels</b>");
      expect(html).toContain("1. <b>External Connectivity</b>");
    });

    it("renders correct 1, 2, 3, 4, 5 numbering on Marked", () => {
      const ir = CANDIDATE_PARSERS["marked"].parse(fixture.input);
      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. <b>Systemd Services</b>");
      expect(html).toContain("2. <b>Database Integrity</b>");
      expect(html).toContain("3. <b>Inward ACP Providers</b>");
      expect(html).toContain("4. <b>Surface Channels</b>");
      expect(html).toContain("5. <b>External Connectivity</b>");
    });

    it("renders correct 1, 2, 3, 4, 5 numbering on markdown-it", () => {
      const ir = CANDIDATE_PARSERS["markdown-it"].parse(fixture.input);
      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. <b>Systemd Services</b>");
      expect(html).toContain("2. <b>Database Integrity</b>");
      expect(html).toContain("3. <b>Inward ACP Providers</b>");
      expect(html).toContain("4. <b>Surface Channels</b>");
      expect(html).toContain("5. <b>External Connectivity</b>");
    });

    it("renders correct 1, 2, 3, 4, 5 numbering on remark", () => {
      const ir = CANDIDATE_PARSERS["remark"].parse(fixture.input);
      const html = renderTelegramHtml(ir);
      expect(html).toContain("1. <b>Systemd Services</b>");
      expect(html).toContain("2. <b>Database Integrity</b>");
      expect(html).toContain("3. <b>Inward ACP Providers</b>");
      expect(html).toContain("4. <b>Surface Channels</b>");
      expect(html).toContain("5. <b>External Connectivity</b>");
    });
  });

  describe("6. Telegram and Discord Surface Rendering Output", () => {
    it("Telegram HTML contains only valid tags and escapes unexpected markup", () => {
      const input = "# Heading\n\n**Bold** and `code`\n\n| H |\n|---|\n| D |";
      const ir = CANDIDATE_PARSERS["marked"].parse(input);
      const html = renderTelegramHtml(ir);
      // Telegram does not support <h1> or <table> in parse_mode: HTML
      expect(html).not.toContain("<h1>");
      expect(html).not.toContain("<table>");
      expect(html).toContain("<b>Heading</b>");
      expect(html).toContain("<b>Bold</b>");
      expect(html).toContain("<code>code</code>");
      // Table rendered as card
      expect(html).toContain("• <b>H</b>: D");
    });

    it("Telegram Rich HTML generates native table tags for Telegram Bot API 10.1+", () => {
      const input = "| Service | Status |\n|---|---|\n| sqlite | active |";
      const ir = CANDIDATE_PARSERS["marked"].parse(input);
      const richHtml = renderTelegramRichHtml(ir);
      expect(richHtml).toContain("<table bordered striped>");
      expect(richHtml).toContain("<th>Service</th>");
      expect(richHtml).toContain("<td>sqlite</td>");
    });

    it("Discord renders Markdown syntax faithfully", () => {
      const input = "### Header\n\n**Bold** and *italic* and `code`\n\n- Bullet";
      const ir = CANDIDATE_PARSERS["marked"].parse(input);
      const discord = renderDiscord(ir);
      expect(discord).toContain("### Header");
      expect(discord).toContain("**Bold**");
      expect(discord).toContain("*italic*");
      expect(discord).toContain("`code`");
      expect(discord).toContain("- Bullet");
    });
  });
});
