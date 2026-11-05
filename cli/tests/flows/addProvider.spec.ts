import { describe, expect, it, vi } from "vitest";
import type { IHarness } from "@racso/core";
import { addProvider, type ProviderTarget } from "../../src/flows/addProvider";
import { removeProvider } from "../../src/flows/removeProvider";
import type {
  ConfirmRequest,
  SelectionRequest,
  TextRequest,
  UiAdapter,
} from "../../src/ui/UiAdapter";

// The provider flows used to read stdin directly, which the TUI cannot afford:
// Ink owns the stream, so the prompts fought the render for the same
// keystrokes. These cases drive the flows through a UI that answers on its
// own, which is exactly the shape the renderer now provides, and pin what the
// harness sees: nothing at all until every answer is in.

type Answers = {
  texts?: (string | undefined)[];
  confirms?: (boolean | undefined)[];
  selections?: (string | undefined)[];
};

const fakeUi = (answers: Answers = {}) => {
  const texts = [...(answers.texts ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  const selections = [...(answers.selections ?? [])];
  const asked: {
    texts: TextRequest[];
    confirms: ConfirmRequest[];
    selections: SelectionRequest[];
  } = {
    texts: [],
    confirms: [],
    selections: [],
  };

  const ui: UiAdapter = {
    render: () => {},
    promptApproval: async () => "deny",
    select: async (request) => {
      asked.selections.push(request);
      return selections.shift();
    },
    promptText: async (request) => {
      asked.texts.push(request);
      return texts.shift();
    },
    confirm: async (request) => {
      asked.confirms.push(request);
      return confirms.shift();
    },
    renderImage: async () => {},
    close: () => {},
  };

  return { ui, asked };
};

const harness = (overrides: Partial<ProviderTarget> = {}) => {
  const configured: unknown[][] = [];
  const target: ProviderTarget = {
    listProviders: () => [],
    configureProvider: (...args: unknown[]) => {
      configured.push(args);
      // The real signature returns nothing relevant to the flow.
      return undefined as unknown as void;
    },
    listProviderDetails: () => [],
    removeProvider: () => true,
    ...overrides,
  };

  return { target, configured };
};

describe("adding a provider", () => {
  it("asks the UI for every value and configures once, at the end", async () => {
    const { ui, asked } = fakeUi({
      texts: ["  Cheap  EU ", "https://example.test/v1", "sk-live-1", "gpt-test"],
      confirms: [true],
      selections: ["anthropic"],
    });
    const { target, configured } = harness();

    const result = await addProvider(ui, target, ["openai", "anthropic"]);

    // The id is normalised by the flow, not by the renderer: spaces become
    // hyphens and the letters go lowercase, because it is the key of a config
    // file the user will type on a command line.
    expect(result).toEqual({ id: "cheap-eu", changedDefault: true });
    expect(configured).toEqual([
      [
        "cheap-eu",
        {
          type: "anthropic",
          url: "https://example.test/v1",
          apikey: "sk-live-1",
          model: "gpt-test",
        },
        { makeDefault: true },
      ],
    ]);
    // The key is asked as a secret: the renderer masks it and it never joins the
    // transcript.
    expect(asked.texts[2]).toEqual({ message: "[cheap-eu] API key:", secret: true });
    expect(asked.selections[0]?.options.map((option) => option.id)).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("leaves the model out when it is answered empty", async () => {
    const { ui } = fakeUi({
      texts: ["cheap", "https://example.test", "sk-1", ""],
      confirms: [false],
    });
    const { target, configured } = harness();

    const result = await addProvider(ui, target);

    expect(result).toEqual({ id: "cheap", changedDefault: false });
    // Without this the two reads below would also pass on a flow that never
    // configured anything at all: `undefined` has no `model` property either.
    expect(configured).toHaveLength(1);
    expect(configured[0]?.[1]).toEqual({
      type: "openai",
      url: "https://example.test",
      apikey: "sk-1",
    });
    expect(configured[0]?.[2]).toEqual({ makeDefault: false });
  });

  it("configures nothing when the model question is cancelled", async () => {
    // Every earlier answer is in by the time the model is asked, so a flow that
    // configured as it went would leave a provider behind. The cancel here is
    // the Esc on an empty field of the renderer, handed over as `undefined`.
    const { ui, asked } = fakeUi({
      texts: ["cheap", "https://example.test", "sk-1", undefined],
      confirms: [true],
    });
    const { target, configured } = harness();

    expect(await addProvider(ui, target)).toBeUndefined();
    expect(configured).toEqual([]);
    // The default question never came up: the flow stopped at the cancel.
    expect(asked.texts).toHaveLength(4);
    expect(asked.confirms).toEqual([]);
  });

  it("cancels half way without configuring anything", async () => {
    // The key question is cancelled: everything before it was answered, so a
    // flow that configured as it went would leave a provider without a key.
    const { ui } = fakeUi({ texts: ["cheap", "https://example.test", undefined] });
    const { target, configured } = harness();

    expect(await addProvider(ui, target)).toBeUndefined();
    expect(configured).toEqual([]);
  });

  it("cancels on the very first question", async () => {
    const { ui, asked } = fakeUi({ texts: [undefined] });
    const { target, configured } = harness();

    expect(await addProvider(ui, target)).toBeUndefined();
    expect(asked.texts).toHaveLength(1);
    expect(configured).toEqual([]);
  });

  it("aborts the overwrite when the answer is not a yes", async () => {
    const { ui } = fakeUi({ texts: ["cheap"], confirms: [false] });
    const { target, configured } = harness({ listProviders: () => ["cheap"] });

    expect(await addProvider(ui, target)).toBeUndefined();
    expect(configured).toEqual([]);
  });

  it("aborts the overwrite when the question is cancelled", async () => {
    const { ui } = fakeUi({ texts: ["cheap"], confirms: [undefined] });
    const { target, configured } = harness({ listProviders: () => ["cheap"] });

    expect(await addProvider(ui, target)).toBeUndefined();
    expect(configured).toEqual([]);
  });

  it("overwrites once the user confirms it", async () => {
    const { ui } = fakeUi({
      texts: ["cheap", "https://example.test", "sk-1", ""],
      confirms: [true, true],
    });
    const { target, configured } = harness({ listProviders: () => ["cheap"] });

    expect(await addProvider(ui, target)).toEqual({ id: "cheap", changedDefault: true });
    expect(configured).toHaveLength(1);
  });

  it("rejects an empty id and an empty url", async () => {
    // A blank line is kept as answered text (the renderer only cancels on a
    // literal empty answer), so the flow is the one that rejects it, before it
    // configures anything.
    const blank = fakeUi({ texts: ["   "] });
    await expect(addProvider(blank.ui, harness().target)).rejects.toThrow(
      "Provider id is required",
    );

    const noUrl = fakeUi({ texts: ["cheap", "   "] });
    await expect(addProvider(noUrl.ui, harness().target)).rejects.toThrow("Base URL is required");
  });

  it("rejects a missing api key", async () => {
    const { ui } = fakeUi({ texts: ["cheap", "https://example.test", "   "] });

    await expect(addProvider(ui, harness().target)).rejects.toThrow("API key is required");
  });

  it("cancels when the backend type picker is cancelled", async () => {
    const { ui } = fakeUi({ texts: ["cheap"], selections: [undefined] });

    expect(await addProvider(ui, harness().target, ["openai", "anthropic"])).toBeUndefined();
  });
});

describe("removing a provider", () => {
  const details = [
    { id: "cheap", type: "openai", isDefault: true },
    { id: "other", type: "anthropic", isDefault: false },
  ] as unknown as ReturnType<IHarness["listProviderDetails"]>;

  it("asks for confirmation and removes on a yes", async () => {
    const removeProviderFn = vi.fn(() => true);
    const { ui, asked } = fakeUi({ confirms: [true] });
    const target = {
      listProviderDetails: () => details,
      removeProvider: removeProviderFn,
    } as unknown as IHarness;

    expect(await removeProvider(ui, target, "cheap")).toBe("cheap");
    expect(removeProviderFn).toHaveBeenCalledWith("cheap");
    // Deleting cannot be undone, so Enter must answer "no".
    expect(asked.confirms[0]).toEqual({
      message: 'Remove provider "cheap"? This cannot be undone.',
      defaultAnswer: false,
    });
  });

  it("gives up without removing when the confirmation is a no", async () => {
    const removeProviderFn = vi.fn(() => true);
    const { ui } = fakeUi({ confirms: [false] });
    const target = {
      listProviderDetails: () => details,
      removeProvider: removeProviderFn,
    } as unknown as IHarness;

    expect(await removeProvider(ui, target, "cheap")).toBeUndefined();
    expect(removeProviderFn).not.toHaveBeenCalled();
  });

  it("cancelling the confirmation removes nothing", async () => {
    const removeProviderFn = vi.fn(() => true);
    const { ui } = fakeUi({ confirms: [undefined] });
    const target = {
      listProviderDetails: () => details,
      removeProvider: removeProviderFn,
    } as unknown as IHarness;

    expect(await removeProvider(ui, target, "cheap")).toBeUndefined();
    expect(removeProviderFn).not.toHaveBeenCalled();
  });

  it("refuses to remove the last configured provider", async () => {
    const { ui, asked } = fakeUi({ confirms: [true] });
    const target = {
      listProviderDetails: () => [details[0]],
      removeProvider: () => true,
    } as unknown as IHarness;

    await expect(removeProvider(ui, target, "cheap")).rejects.toThrow(
      "Cannot remove the last configured provider",
    );
    expect(asked.confirms).toHaveLength(0);
  });
});
