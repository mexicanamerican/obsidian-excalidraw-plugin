import { debug } from "src/utils/debugHelper";
import { App, FrontMatterCache, MarkdownView, MetadataCache, normalizePath, Notice, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { BLANK_DRAWING, DARK_BLANK_DRAWING, DEVICE, EXPORT_TYPES, FRONTMATTER, FRONTMATTER_KEYS, JSON_parse, nanoid, VIEW_TYPE_EXCALIDRAW } from "src/constants/constants";
import { Prompt, templatePromt } from "src/shared/Dialogs/Prompt";
import { changeThemeOfExcalidrawMD, ExcalidrawData, getMarkdownDrawingSection } from "../../shared/ExcalidrawData";
import ExcalidrawView, { getTextMode } from "src/view/ExcalidrawView";
import ExcalidrawPlugin from "src/core/main";
import { DEBUGGING } from "src/utils/debugHelper";
import { checkAndCreateFolder, createFileAndAwaitMetacacheUpdate, download, getIMGFilename, getLink, getListOfTemplateFiles, getNewUniqueFilepath } from "src/utils/fileUtils";
import { PaneTarget } from "src/utils/modifierkeyHelper";
import { getExcalidrawViews, getNewOrAdjacentLeaf, isObsidianThemeDark, openLeaf } from "src/utils/obsidianUtils";
import { errorlog, getExportTheme } from "src/utils/utils";
import { imageCache } from "src/shared/ImageCache";

export class PluginFileManager {
  private plugin: ExcalidrawPlugin;
  private app: App;
  private excalidrawFiles: Set<TFile> = new Set<TFile>();

  get settings() {
    return this.plugin.settings;
  }

  constructor(plugin: ExcalidrawPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  public async initialize() {
    await this.plugin.awaitInit();
    const metaCache: MetadataCache = this.app.metadataCache;
    metaCache.getCachedFiles().forEach((filename: string) => {
      const fm = metaCache.getCache(filename)?.frontmatter;
      if (
        (fm && typeof fm[FRONTMATTER_KEYS["plugin"].name] !== "undefined") ||
        filename.match(/\.excalidraw$/)
      ) {
        this.updateFileCache(
          this.app.vault.getAbstractFileByPath(filename) as TFile,
          fm,
        );
      }
    });
  }

  public isExcalidrawFile(f: TFile): boolean {
    if(!f) return false;
    if (f.extension === "excalidraw") {
      return true;
    }
    const fileCache = f ? this.plugin.app.metadataCache.getFileCache(f) : null;
    return !!fileCache?.frontmatter && !!fileCache.frontmatter[FRONTMATTER_KEYS["plugin"].name];
  }

  //managing my own list of Excalidraw files because in the onDelete event handler
  //the file object is already gone from metadataCache, thus I can't check if it was an Excalidraw file
  public updateFileCache(
    file: TFile,
    frontmatter?: FrontMatterCache,
    deleted: boolean = false,
  ) {
    if (frontmatter && typeof frontmatter[FRONTMATTER_KEYS["plugin"].name] !== "undefined") {
      this.excalidrawFiles.add(file);
      return;
    }
    if (!deleted && file.extension === "excalidraw") {
      this.excalidrawFiles.add(file);
      return;
    }
    this.excalidrawFiles.delete(file);
  }

  public getExcalidrawFiles(): Set<TFile> {
    return this.excalidrawFiles;
  }

  public destroy() {
    this.excalidrawFiles.clear();
  }

  public async createDrawing(
    filename: string,
    foldername?: string,
    initData?: string,
  ): Promise<TFile> {
    const folderpath = normalizePath(
      foldername ? foldername : this.settings.folder,
    );
    await checkAndCreateFolder(folderpath); //create folder if it does not exist
    const fname = getNewUniqueFilepath(this.app.vault, filename, folderpath);
    const file = await this.app.vault.create(
      fname,
      initData ?? (await this.plugin.getBlankDrawing()),
    );
    
    //wait for metadata cache
    let counter = 0;
    while(file instanceof TFile && !this.isExcalidrawFile(file) && counter++<10) {
      await sleep(50);
    }
    
    if(counter > 10) {
      errorlog({file, error: "new drawing not recognized as an excalidraw file", fn: this.createDrawing});
    }

    return file;
  }

  public async getBlankDrawing(): Promise<string> {
    const templates = getListOfTemplateFiles(this.plugin);
    if(templates) {
      const template = await templatePromt(templates, this.app);
      if (template && template instanceof TFile) {
        if (
          (template.extension == "md" && !this.settings.compatibilityMode) ||
          (template.extension == "excalidraw" && this.settings.compatibilityMode)
        ) {
          const data = await this.app.vault.read(template);
          if (data) {
            return this.settings.matchTheme
              ? changeThemeOfExcalidrawMD(data)
              : data;
          }
        }
      }
    }
    if (this.settings.compatibilityMode) {
      return this.settings.matchTheme && isObsidianThemeDark()
        ? DARK_BLANK_DRAWING
        : BLANK_DRAWING;
    }
    const blank =
      this.settings.matchTheme && isObsidianThemeDark()
        ? DARK_BLANK_DRAWING
        : BLANK_DRAWING;
    return `${FRONTMATTER}\n${getMarkdownDrawingSection(
      blank,
      this.settings.compress,
    )}`;
  }

  public async embedDrawing(file: TFile) {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      const excalidrawRelativePath = this.app.metadataCache.fileToLinktext(
        file,
        activeView.file.path,
        this.settings.embedType === "excalidraw",
      );
      const editor = activeView.editor;

      //embed Excalidraw
      if (this.settings.embedType === "excalidraw") {
        editor.replaceSelection(
          getLink(this.plugin, {path: excalidrawRelativePath}),
        );
        editor.focus();
        return;
      }

      //embed image
      let theme = this.settings.autoExportLightAndDark
        ? getExportTheme (
          this.plugin,
          file,
          this.settings.exportWithTheme
            ? isObsidianThemeDark() ? "dark":"light"
            : "light"
          )
        : "";

      theme = (theme === "")
       ? ""
       : theme + ".";

      const exportExtension = theme+this.settings.embedType.toLowerCase();
      let imageFullpath = getIMGFilename(
        file.path,
        exportExtension,
      );
     
      if(this.plugin.ea?.onImageExportPathHook) {
        try {
          imageFullpath = this.plugin.ea.onImageExportPathHook({
            exportFilepath: imageFullpath,
            exportExtension,
            excalidrawFile: file,
            action: "export",
          }) ?? imageFullpath;
        } catch (e) {
          errorlog({where: "FileManager.embedDrawing", fn: this.plugin.ea.onImageExportPathHook, error: e});
        }
      }

      const createFile = async (path: string):Promise<TFile> => {
        return await createFileAndAwaitMetacacheUpdate(this.app, path, 
          this.settings.embedType === "SVG"
            ? `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>`
            : new Uint8Array([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
                0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
                0x49, 0x48, 0x44, 0x52, // IHDR
                0x00, 0x00, 0x00, 0x01, // width: 1
                0x00, 0x00, 0x00, 0x01, // height: 1
                0x08, 0x06, 0x00, 0x00, 0x00, // bit depth: 8, color type: 6 (RGBA), compression: 0, filter: 0, interlace: 0
                0x1F, 0x15, 0xC4, 0x89, // IHDR CRC
                0x00, 0x00, 0x00, 0x0B, // IDAT chunk length
                0x49, 0x44, 0x41, 0x54, // IDAT
                0x78, 0x9C, 0x62, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, // compressed data (1x1 transparent pixel)
                0x0A, 0x2D, 0xB4, // IDAT CRC
                0x00, 0x00, 0x00, 0x00, // IEND chunk length
                0x49, 0x45, 0x4E, 0x44, // IEND
                0xAE, 0x42, 0x60, 0x82  // IEND CRC
              ]).buffer
        );
      }

      let imgFile = this.app.vault.getFileByPath(imageFullpath);
      if (!imgFile) {
        imgFile = await createFile(imageFullpath);
      }

      const imageRelativePath = this.app.metadataCache.fileToLinktext(
        imgFile,
        activeView.file.path,
        false,
      );

      //will hold incorrect value if theme==="", however in that case it won't be used
      const otherTheme = theme === "dark." ? "light." : "dark.";
      //if the hook tinkers with the extension, then I cannot predict the other theme's extension
      //it would become a messy heuristic to try to guess the other theme's extension
      const otherImageRelativePath = ((theme === "") || !imageRelativePath.endsWith(exportExtension))
        ? null
        : (imageRelativePath.substring(0, imageRelativePath.lastIndexOf(exportExtension)) + otherTheme+this.settings.embedType.toLowerCase());

      if(otherImageRelativePath) {
        await createFile(
          imgFile.path.substring(0, imgFile.path.lastIndexOf(exportExtension)) + otherTheme+this.settings.embedType.toLowerCase()
        );
      }

      const inclCom = this.settings.embedMarkdownCommentLinks;

      editor.replaceSelection(
        this.settings.embedWikiLink
          ? `![[${imageRelativePath}]]\n` +
            (inclCom
              ? `%%[[${excalidrawRelativePath}|🖋 Edit in Excalidraw]]${
                otherImageRelativePath
                  ? ", and the [["+otherImageRelativePath+"|"+otherTheme.split(".")[0]+" exported image]]"
                  : ""
                }%%`
              : "")
          : `![](${encodeURI(imageRelativePath)})\n` + 
            (inclCom ? `%%[🖋 Edit in Excalidraw](${encodeURI(excalidrawRelativePath,
              )})${otherImageRelativePath?", and the ["+otherTheme.split(".")[0]+" exported image]("+encodeURI(otherImageRelativePath)+")":""}%%` : ""),
      );
      editor.focus();
    }
  }

  public async exportLibrary() {
    if (DEVICE.isMobile) {
      const prompt = new Prompt(
        this.app,
        "Please provide a filename",
        "my-library",
        "filename, leave blank to cancel action",
      );
      prompt.openAndGetValue(async (filename: string) => {
        if (!filename) {
          return;
        }
        filename = `${filename}.excalidrawlib`;
        const folderpath = normalizePath(this.settings.folder);
        await checkAndCreateFolder(folderpath); //create folder if it does not exist
        const fname = getNewUniqueFilepath(
          this.app.vault,
          filename,
          folderpath,
        );
        this.app.vault.create(fname, this.settings.library);
        new Notice(`Exported library to ${fname}`, 6000);
      });
      return;
    }
    download(
      "data:text/plain;charset=utf-8",
      encodeURIComponent(JSON.stringify(this.settings.library2, null, "\t")),
      "my-obsidian-library.excalidrawlib",
    );
  }

  /**
   * Opens a drawing file
   * @param drawingFile 
   * @param location 
   * @param active 
   * @param subpath 
   * @param justCreated 
   * @param popoutLocation 
   */
  public openDrawing(
    drawingFile: TFile,
    location: PaneTarget,
    active: boolean = false,
    subpath?: string,
    justCreated: boolean = false,
    popoutLocation?: {x?: number, y?: number, width?: number, height?: number},
  ) {

    const fnGetLeaf = ():WorkspaceLeaf => {
      if(location === "md-properties") {
        location = "new-tab";
      }
      let leaf: WorkspaceLeaf;
      if(location === "popout-window") {
        leaf = this.app.workspace.openPopoutLeaf(popoutLocation);
      }
      if(location === "new-tab") {
        leaf = this.app.workspace.getLeaf('tab');
      }
      if(!leaf) {
        leaf = this.app.workspace.getLeaf(false);
        if ((leaf.view.getViewType() !== 'empty') && (location === "new-pane")) {
          leaf = getNewOrAdjacentLeaf(this.plugin, leaf)    
        }
      }
      return leaf;
    }

    const {leaf, promise} = openLeaf({
      plugin: this.plugin,
      fnGetLeaf: () => fnGetLeaf(),
      file: drawingFile,
      openState:!subpath || subpath === "" 
        ? {active}
        : { active, eState: { subpath } }
    });

    promise.then(()=>{
      const ea = this.plugin.ea;
      if(justCreated && ea.onFileCreateHook) {
        try {
          ea.onFileCreateHook({
            ea,
            excalidrawFile: drawingFile,
            view: leaf.view as ExcalidrawView,
          });
        } catch(e) {
          console.error(e);
        }
      }
    })
  }

  /**
 * Extracts the text elements from an Excalidraw scene into a string of ids as headers followed by the text contents
 * @param {string} data - Excalidraw scene JSON string
 * @returns {string} - Text starting with the "# Text Elements" header and followed by each "## id-value" and text
 */
  public async exportSceneToMD(data: string, compressOverride?: boolean): Promise<string> {
    if (!data) {
      return "";
    }
    const excalidrawData = JSON_parse(data);
    const textElements = excalidrawData.elements?.filter(
      (el: any) => el.type == "text",
    );
    let outString = `# Excalidraw Data\n\n## Text Elements\n`;
    let id: string;
    for (const te of textElements) {
      id = te.id;
      //replacing Excalidraw text IDs with my own, because default IDs may contain
      //characters not recognized by Obsidian block references
      //also Excalidraw IDs are inconveniently long
      if (te.id.length > 8) {
        id = nanoid();
        data = data.replaceAll(te.id, id); //brute force approach to replace all occurrences.
      }
      outString += `${te.originalText ?? te.text} ^${id}\n\n`;
    }
    return (
      outString +
      getMarkdownDrawingSection(
        JSON.stringify(JSON_parse(data), null, "\t"),
        typeof compressOverride === "undefined"
        ? this.settings.compress
        : compressOverride,
      )
    );
  }


  // -------------------------------------------------------
  // ------------------ Event Handlers ---------------------
  // -------------------------------------------------------

  /**
   * watch filename change to rename .svg, .png; to sync to .md; to update links
   * @param file 
   * @param oldPath 
   * @returns 
   */
  public async renameEventHandler (file: TAbstractFile, oldPath: string) {
    (process.env.NODE_ENV === 'development') && DEBUGGING && debug(this.renameEventHandler, `ExcalidrawPlugin.renameEventHandler`, file, oldPath);
    if (!(file instanceof TFile)) {
      return;
    }
    if (!this.isExcalidrawFile(file)) {
      return;
    }
    this.moveBAKFile(oldPath, file.path);
    
    if (!this.settings.keepInSync) {
      return;
    }
    const imgMap = new Map<string, {oldImgPath: string, newImgPath: string}>();
    [EXPORT_TYPES, "excalidraw"].flat().forEach(ext => {
      let oldImgPath = getIMGFilename(oldPath, ext);
      let newImgPath = getIMGFilename(file.path, ext);
      if(this.plugin.ea?.onImageExportPathHook) {
        try {
          oldImgPath = this.plugin.ea.onImageExportPathHook({
            exportFilepath: oldImgPath,
            exportExtension: ext,
            excalidrawFile: file,
            oldExcalidrawPath: oldPath,
            action: "move",
          }) ?? oldImgPath;
          newImgPath = this.plugin.ea.onImageExportPathHook({
            exportFilepath: newImgPath,
            exportExtension: ext,
            excalidrawFile: file,
            action: "export",
          }) ?? newImgPath;
        } catch (e) {
          errorlog({where: "FileManager.renameEventHandler", fn: this.plugin.ea.onImageExportPathHook, error: e});
        }
      }
      imgMap.set(ext, { oldImgPath, newImgPath });
    });

    imgMap.forEach((path, ext) => {
      const imgFile = this.app.vault.getFileByPath(
        normalizePath(path.oldImgPath),
      );
      if (imgFile) {
        this.app.fileManager.renameFile(imgFile, normalizePath(path.newImgPath));
      }
    });
  }

  public async modifyEventHandler (file: TFile) {
    (process.env.NODE_ENV === 'development') && DEBUGGING && debug(this.modifyEventHandler,`FileManager.modifyEventHandler`, file);
    const excalidrawViews = getExcalidrawViews(this.app);
    excalidrawViews.forEach(async (excalidrawView) => {
      if(excalidrawView.semaphores?.viewunload) {
        return;
      }
      if (
        excalidrawView.file &&
        (excalidrawView.file.path === file.path ||
          (file.extension === "excalidraw" &&
            `${file.path.substring(
              0,
              file.path.lastIndexOf(".excalidraw"),
            )}.md` === excalidrawView.file.path))
      ) {
        if(excalidrawView.semaphores?.preventReload) {
          excalidrawView.semaphores.preventReload = false;
          return;
        }


        // Avoid synchronizing or reloading if the user hasn't interacted with the file for 5 minutes.
        // This prevents complex sync issues when multiple remote changes occur outside an active collaboration session.

        // The following logic handles a rare edge case where:
        // 1. The user opens an Excalidraw file.
        // 2. Immediately splits the view without saving Excalidraw (since no changes were made).
        // 3. Switches the new split view to Markdown, edits the file, and quickly returns to Excalidraw.
        // 4. The "modify" event may fire while Excalidraw is active, triggering an unwanted reload and zoom reset.

        // To address this:
        // - We check if the user is currently editing the Markdown version of the Excalidraw file in a split view.  
        // - As a heuristic, we also check for recent leaf switches.  
        //   This is not perfectly accurate (e.g., rapid switching between views within a few seconds),  
        //   but it is sufficient to avoid most edge cases without introducing complexity.

        // Edge case impact:  
        // - In extremely rare situations, an update arriving within the "recent switch" timeframe (e.g., from Obsidian Sync)  
        //   might not trigger a reload. This is unlikely and an acceptable trade-off for better user experience.
        const activeView = this.app.workspace.activeLeaf.view;
        const isEditingMarkdownSideInSplitView = ((activeView !== excalidrawView) &&
          activeView instanceof MarkdownView && activeView.file === excalidrawView.file) ||
          (activeView === excalidrawView && this.plugin.isRecentSplitViewSwitch());

        if(!isEditingMarkdownSideInSplitView && (excalidrawView.lastSaveTimestamp + 300000 < Date.now())) {
          excalidrawView.reload(true, excalidrawView.file);
          return;
        }           
        if(file.extension==="md") {
          if(excalidrawView.semaphores?.embeddableIsEditingSelf) return;
          const inData = new ExcalidrawData(this.plugin);
          const data = await this.app.vault.read(file);
          await inData.loadData(data,file,getTextMode(data));
          excalidrawView.synchronizeWithData(inData);
          inData.destroy();
          if(excalidrawView?.isDirty()) {
            if(excalidrawView.autosaveTimer && excalidrawView.autosaveFunction) {
              clearTimeout(excalidrawView.autosaveTimer);
            }
            if(excalidrawView.autosaveFunction) {
              excalidrawView.autosaveFunction();
            }
          }
        } else {
          excalidrawView.reload(true, excalidrawView.file);
        }
      }
    });
  }

  private async removeBAKFromCache(path: string) {
    //this will not work in a short period when Obsidian is starting up, however
    //because there is housekeeping in ImageCache at each startup to delete
    //BAK files, this is not a major issue.
    if(!imageCache.isReady() || !path) {
      return;
    }  
    await imageCache.removeBAKFromCache(path);
  }

  private async moveBAKFile(oldPath: string, newPath: string) {
    if(!oldPath || !newPath) {
      return;
    }
    //this will not work in the short period when Obsidian is starting up, however
    //this will only effect a very few files, statistically unlikely to cause
    //much/any real user impact.
    //a proper queuing feels overkill for this.
    if(!imageCache.isReady()) {
      return;
    }
    const backup = await imageCache.getBAKFromCache(oldPath);
    if(backup) {
      await imageCache.addBAKToCache(newPath, `${backup}`);
      await this.removeBAKFromCache(oldPath);
    }
  }

  /**
   * watch file delete and delete corresponding .svg and .png
   * @param file 
   * @returns 
   */
  public async deleteEventHandler (file: TFile) {
    (process.env.NODE_ENV === 'development') && DEBUGGING && debug(this.deleteEventHandler,`ExcalidrawPlugin.deleteEventHandler`, file);
    if (!(file instanceof TFile)) {
      return;
    }

    const isExcalidarwFile = this.getExcalidrawFiles().has(file);
    this.updateFileCache(file, undefined, true);
    if (!isExcalidarwFile) {
      return;
    }

    //close excalidraw view where this file is open
    const excalidrawViews = getExcalidrawViews(this.app);
    for (const excalidrawView of excalidrawViews) {
      if (file?.path && excalidrawView?.file?.path === file.path) {
        await excalidrawView.leaf.setViewState({
          type: VIEW_TYPE_EXCALIDRAW,
          state: { file: null },
        });
      }
    }

    this.removeBAKFromCache(file.path);

    //delete PNG and SVG files as well
    if (this.settings.keepInSync) {
      const imgMap = new Map<string, string>();
      [EXPORT_TYPES, "excalidraw"].flat().forEach(ext => {
        let imgPath = getIMGFilename(file.path, ext);
        if(this.plugin.ea?.onImageExportPathHook) {
          try {
            imgPath = this.plugin.ea.onImageExportPathHook({
              exportFilepath: imgPath,
              exportExtension: ext,
              excalidrawFile: file,
              action: "delete",
            }) ?? imgPath;
          } catch (e) {
            errorlog({where: "FileManager.deleteEventHandler", fn: this.plugin.ea.onImageExportPathHook, error: e});
          }
        }
        imgMap.set(ext, imgPath);
      });
      
      window.setTimeout(() => {
        imgMap.forEach((imgPath: string, ext: string) => {        
          const imgFile = this.app.vault.getFileByPath(
            normalizePath(imgPath),
          );
          if (imgFile) {
            this.app.vault.delete(imgFile);
          }
        });
      }, 500);
    }
  };

}