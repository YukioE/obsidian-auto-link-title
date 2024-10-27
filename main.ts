import { CheckIf } from "checkif"
import { EditorExtensions } from "editor-enhancements"
import { Editor, Notice, Plugin } from "obsidian"
import getPageTitle from "scraper"
import { scrapeFirstURL, getFaviconElement } from "scraper"
import getElectronPageTitle from "electron-scraper"
import {
  AutoLinkTitleSettingTab,
  AutoLinkTitleSettings,
  DEFAULT_SETTINGS,
} from "./settings"

interface PasteFunction {
  (this: HTMLElement, ev: ClipboardEvent): void;
}

interface DropFunction {
  (this: HTMLElement, ev: DragEvent): void;
}

export default class AutoLinkTitle extends Plugin {
  settings: AutoLinkTitleSettings;
  pasteFunction: PasteFunction;
  dropFunction: DropFunction;
  blacklist: Array<string>;

  async onload() {
    console.log("loading obsidian-auto-link-title");
    await this.loadSettings();

    this.blacklist = this.settings.websiteBlacklist.split(",").map(s => s.trim()).filter(s => s.length > 0);

    // Listen to paste event
    this.pasteFunction = this.pasteUrlWithTitle.bind(this);

    // Listen to drop event
    this.dropFunction = this.dropUrlWithTitle.bind(this);

    this.addCommand({
      id: "auto-link-title-paste",
      name: "Paste URL and auto fetch title",
      editorCallback: (editor) => this.manualPasteUrlWithTitle(editor),
      hotkeys: [],
    });

    this.addCommand({
      id: "auto-link-title-normal-paste",
      name: "Normal paste (no fetching behavior)",
      editorCallback: (editor) => this.normalPaste(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "v",
        },
      ],
    });

    this.registerEvent(
      this.app.workspace.on("editor-paste", this.pasteFunction)
    );

    this.registerEvent(
      this.app.workspace.on("editor-drop", this.dropFunction)
    );

    this.addCommand({
      id: "enhance-url-with-title",
      name: "Enhance existing URL with link and title",
      editorCallback: (editor) => this.addTitleToLink(editor),
      hotkeys: [
        {
          modifiers: ["Mod", "Shift"],
          key: "e",
        },
      ],
    });

    this.addCommand({
      id: "fetch-first-link",
      name: "Fetch first Google link of selected text",
      editorCallback: (editor) => this.fetchFirstLink(editor),
      hotkeys: [],
    });

    this.addCommand({
      id: "enhance-with-favicon",
      name: "Enhance link with favicon",
      editorCallback: (editor) => this.enhanceWithFavicon(editor),
      hotkeys: [],
    });

    this.addSettingTab(new AutoLinkTitleSettingTab(this.app, this));
  }

  addTitleToLink(editor: Editor): void {
    // Only attempt fetch if online
    if (!navigator.onLine) return;

    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();

    // If the cursor is on a raw html link, convert to a markdown link and fetch title
    if (CheckIf.isUrl(selectedText)) {
      this.convertUrlToTitledLink(editor, selectedText);
    }
    // If the cursor is on the URL part of a markdown link, fetch title and replace existing link title
    else if (CheckIf.isLinkedUrl(selectedText)) {
      const link = this.getUrlFromLink(selectedText)
      this.convertUrlToTitledLink(editor, link)
    }
  }

  async fetchFirstLink(editor: Editor): Promise<void> {
    if (!navigator.onLine) {
      new Notice("You must be online to use this feature");
      return;
    }

    let selectedText = (EditorExtensions.getSelectedText(editor) || "");

    if (selectedText.trim() === "" || selectedText === null) {
      new Notice("No text selected");
      return;
    }

    // Generate a unique id for find/replace operations for the link.
    const pasteId = `Fetching Link#${this.createBlockHash()}`;

    if (this.settings.apiKey.trim() === "" || this.settings.customSearchEngineId.trim() === "") {
      new Notice("You must set your Google API Key and Custom Search Engine ID in the settings");
      return;
    }

    // Instantly paste so you don't wonder if paste is broken
    editor.replaceSelection(`[${selectedText}](${pasteId})`);

    // Fetch link from site, replace Fetching Link with actual link
    const link = await scrapeFirstURL(
       this.settings.apiKey,
       this.settings.customSearchEngineId,
       selectedText
      );
    
    const text = editor.getValue();

    const start = text.indexOf(pasteId);
    if (start < 0) {
      console.log(
        `Unable to find text "${pasteId}" in current editor, bailing out; link ${link}`
      );
    } else {
      const end = start + pasteId.length;
      const startPos = EditorExtensions.getEditorPositionFromIndex(text, start);
      const endPos = EditorExtensions.getEditorPositionFromIndex(text, end);

      editor.replaceRange(link, startPos, endPos);

      this.pasteFavicon(editor, link, selectedText)
    }

    return;
  }

  async enhanceWithFavicon(editor: Editor): Promise<void> {
    // Only attempt fetch if online
    if (!navigator.onLine) return;

    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();

    // If the cursor is on a raw html link, insert favicon at the start of the link
    if (CheckIf.isUrl(selectedText)) {
      this.pasteFavicon(editor, selectedText, selectedText, true);
    }

    // If the cursor is on the URL part of a markdown link, insert favicon at the start of the already existing title
    else if (CheckIf.isLinkedUrl(selectedText)) {
      const link = this.getUrlFromLink(selectedText);
      this.pasteFavicon(editor, link, selectedText);
    }
  }

  async normalPaste(editor: Editor): Promise<void> {
    let clipboardText = await navigator.clipboard.readText();
    if (clipboardText === null || clipboardText === "") return;

    editor.replaceSelection(clipboardText);
  }

  // Simulate standard paste but using editor.replaceSelection with clipboard text since we can't seem to dispatch a paste event.
  async manualPasteUrlWithTitle(editor: Editor): Promise<void> {
    const clipboardText = await navigator.clipboard.readText()

    // Only attempt fetch if online
    if (!navigator.onLine) {
      editor.replaceSelection(clipboardText);
      return;
    }

    if (clipboardText == null || clipboardText == '') return

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title, 
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${clipboardText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, clipboardText);
    return;
  }

  async pasteUrlWithTitle(clipboard: ClipboardEvent, editor: Editor): Promise<void> {
    if (!this.settings.enhanceDefaultPaste) {
      return;
    }

    if (clipboard.defaultPrevented) return;

    // Only attempt fetch if online
    if (!navigator.onLine) return;

    let clipboardText = clipboard.clipboardData.getData("text/plain");
    if (clipboardText === null || clipboardText === "") return;

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(clipboardText) || CheckIf.isImage(clipboardText)) {
      return;
    }


    // We've decided to handle the paste, stop propagation to the default handler.
    clipboard.stopPropagation();
    clipboard.preventDefault();

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(clipboardText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title, 
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${clipboardText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, clipboardText);
    return;
  }

  async dropUrlWithTitle(dropEvent: DragEvent, editor: Editor): Promise<void> {
    if (!this.settings.enhanceDropEvents) {
      return;
    }

    if (dropEvent.defaultPrevented) return;

    // Only attempt fetch if online
    if (!navigator.onLine) return;

    let dropText = dropEvent.dataTransfer.getData('text/plain');
    if (dropText === null || dropText === "") return;

    // If its not a URL, we return false to allow the default paste handler to take care of it.
    // Similarly, image urls don't have a meaningful <title> attribute so downloading it
    // to fetch the title is a waste of bandwidth.
    if (!CheckIf.isUrl(dropText) || CheckIf.isImage(dropText)) {
      return;
    }

    // We've decided to handle the paste, stop propagation to the default handler.
    dropEvent.stopPropagation();
    dropEvent.preventDefault();

    // If it looks like we're pasting the url into a markdown link already, don't fetch title
    // as the user has already probably put a meaningful title, also it would lead to the title
    // being inside the link.
    if (CheckIf.isMarkdownLinkAlready(editor) || CheckIf.isAfterQuote(editor)) {
      editor.replaceSelection(dropText);
      return;
    }

    // If url is pasted over selected text and setting is enabled, no need to fetch title, 
    // just insert a link
    let selectedText = (EditorExtensions.getSelectedText(editor) || "").trim();
    if (selectedText && this.settings.shouldPreserveSelectionAsTitle) {
      editor.replaceSelection(`[${selectedText}](${dropText})`);
      return;
    }

    // At this point we're just pasting a link in a normal fashion, fetch its title.
    this.convertUrlToTitledLink(editor, dropText);
    return;
  }

  async isBlacklisted(url: string): Promise<boolean> {
    await this.loadSettings();
    this.blacklist = this.settings.websiteBlacklist.split(/,|\n/).map(s => s.trim()).filter(s => s.length > 0)
    return this.blacklist.some(site => url.includes(site))
  }

  async convertUrlToTitledLink(editor: Editor, url: string): Promise<void> {
    if (await this.isBlacklisted(url)) {
      let domain = new URL(url).hostname;
      editor.replaceSelection(`[${domain}](${url})`);
      return;
    }

    // Generate a unique id for find/replace operations for the title.
    const pasteId = `Fetching Title#${this.createBlockHash()}`;

    // Instantly paste so you don't wonder if paste is broken
    editor.replaceSelection(`[${pasteId}](${url})`);

    // Fetch title from site, replace Fetching Title with actual title
    const title = await this.fetchUrlTitle(url);
    const escapedTitle = this.escapeMarkdown(title);
    const shortenedTitle = this.shortTitle(escapedTitle);

    const text = editor.getValue();

    const start = text.indexOf(pasteId);
    if (start < 0) {
      console.log(
        `Unable to find text "${pasteId}" in current editor, bailing out; link ${url}`
      );
    } else {
      const end = start + pasteId.length;
      const startPos = EditorExtensions.getEditorPositionFromIndex(text, start);
      const endPos = EditorExtensions.getEditorPositionFromIndex(text, end);

      editor.replaceRange(shortenedTitle, startPos, endPos);

      this.pasteFavicon(editor, url, shortenedTitle)
    }
  }

  escapeMarkdown(text: string): string {
    var unescaped = text.replace(/\\(\*|_|`|~|\\|\[|\])/g, '$1') // unescape any "backslashed" character
    var escaped = unescaped.replace(/(\*|_|`|<|>|~|\\|\[|\])/g, '\\$1') // escape *, _, `, ~, \, [, ], <, and >
    return escaped
  }

  public shortTitle = (title: string): string => {
    if (this.settings.maximumTitleLength === 0) {
      return title;
    }
    if (title.length < this.settings.maximumTitleLength + 3) {
      return title;
    }
    const shortenedTitle = `${title.slice(0, this.settings.maximumTitleLength)}...`;
    return shortenedTitle;
  }

  async fetchUrlTitle(url: string): Promise<string> {
    try {
      let title = "";
      if (this.settings.useNewScraper) {
        title = await getPageTitle(url);
      } else {
        title = await getElectronPageTitle(url);
      }
      return title.replace(/(\r\n|\n|\r)/gm, "").trim();
    } catch (error) {
      console.error(error)
      return 'Error fetching title'
    }
  }

  public getUrlFromLink(link: string): string {
    let urlRegex = new RegExp(DEFAULT_SETTINGS.linkRegex);
    return urlRegex.exec(link)[2];
  }

  private pasteFavicon(editor: Editor, link: string, selectedText: string, insertAtLink?: boolean): void {
    if (this.settings.insertFavicons) {
      const text = editor.getValue();
      const favicon = getFaviconElement(link);

      if (!insertAtLink) {
        // get position of first bracket at the start of the links title e.g. [title](url)
        const bracketIndex = text.lastIndexOf("[", text.indexOf(selectedText)) + 1;
        const bracketPos = EditorExtensions.getEditorPositionFromIndex(text, bracketIndex);
        
        editor.replaceRange(favicon, bracketPos);
      } else {
        // get position of the start of the link
        const linkIndex = text.indexOf(selectedText);
        const linkPos = EditorExtensions.getEditorPositionFromIndex(text, linkIndex);

        editor.replaceRange(favicon, linkPos);
      }
    }
    return;
  }

  // Custom hashid by @shabegom
  private createBlockHash(): string {
    let result = "";
    var characters = "abcdefghijklmnopqrstuvwxyz0123456789";
    var charactersLength = characters.length;
    for (var i = 0; i < 4; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  onunload() {
    console.log("unloading obsidian-auto-link-title");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
