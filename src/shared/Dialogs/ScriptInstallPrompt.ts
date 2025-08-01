import { MarkdownRenderer, Modal, Notice, request } from "obsidian";
import ExcalidrawPlugin from "../../core/main";
import { errorlog } from "../../utils/utils";
import { log } from "src/utils/debugHelper";
import { ContentSearcher } from "../components/ContentSearcher";

const URL =
  "https://raw.githubusercontent.com/zsviczian/obsidian-excalidraw-plugin/master/ea-scripts/index-new.md";

export class ScriptInstallPrompt extends Modal {
  private contentDiv: HTMLDivElement;

  constructor(private plugin: ExcalidrawPlugin) {
    super(plugin.app);
    //    this.titleEl.setText(t("INSTAL_MODAL_TITLE"));
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add("excalidraw-scriptengine-install");
    this.contentDiv = document.createElement("div");
    this.contentEl.appendChild(this.contentDiv);

    new ContentSearcher(this.contentDiv);

    this.containerEl.classList.add("excalidraw-scriptengine-install");
    try {
      const source = await request({ url: URL });
      if (!source) {
        new Notice(
          "Error opening the Excalidraw Script Store page. " +
            "Please double check that you can access the website. " +
            "I've logged the link in developer console (press CTRL+SHIFT+i)",
          5000,
        );
        log(URL);
        this.close();
        return;
      }
      await MarkdownRenderer.render(
        this.plugin.app,
        source,
        this.contentDiv,
        "",
        this.plugin,
      );
      this.contentDiv
        .querySelectorAll("h1[data-heading],h2[data-heading],h3[data-heading]")
        .forEach((el) => {
          el.setAttribute("id", el.getAttribute("data-heading"));
        });
      this.contentDiv.querySelectorAll("a.internal-link").forEach((el) => {
        el.removeAttribute("target");
      });
    } catch (e) {
      errorlog({ where: "ScriptInstallPrompt.onOpen", error: e });
      new Notice("Could not open ScriptEngine repository");
      this.close();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
