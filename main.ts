import { Plugin, TextFileView, WorkspaceLeaf, setIcon, TFile, Notice, Platform } from 'obsidian';

declare module 'obsidian' {
	interface App {
		/** Undocumented: opens a vault file with the OS's default application. */
		openWithDefaultApp(path: string): void;
	}
}

const VIEW_TYPE_URL = 'url-file-preview';

// ── INI parser (preserves insertion order and unknown keys/sections) ──────────

interface IniEntry {
	key: string;
	value: string;
}

interface IniSection {
	name: string;
	entries: IniEntry[];
}

interface ParsedIni {
	sections: IniSection[];
}

function parseIni(content: string): ParsedIni {
	const sections: IniSection[] = [];
	let current: IniSection | null = null;

	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';') || line.startsWith('#')) continue;

		const sectionMatch = line.match(/^\[(.+)\]$/);
		if (sectionMatch) {
			current = { name: sectionMatch[1], entries: [] };
			sections.push(current);
			continue;
		}

		const eqIdx = line.indexOf('=');
		if (eqIdx !== -1 && current) {
			current.entries.push({
				key: line.slice(0, eqIdx).trim(),
				// preserve trailing spaces / casing in values
				value: line.slice(eqIdx + 1),
			});
		}
	}

	return { sections };
}

function serializeIni(ini: ParsedIni): string {
	return ini.sections
		.map(s =>
			[`[${s.name}]`, ...s.entries.map(e => `${e.key}=${e.value}`)].join('\n'),
		)
		.join('\n');
}

function iniGet(ini: ParsedIni, section: string, key: string): string {
	return (
		ini.sections
			.find(s => s.name === section)
			?.entries.find(e => e.key === key)?.value ?? ''
	);
}

function iniSet(ini: ParsedIni, section: string, key: string, value: string): void {
	let s = ini.sections.find(s => s.name === section);
	if (!s) {
		s = { name: section, entries: [] };
		ini.sections.unshift(s);
	}
	const entry = s.entries.find(e => e.key === key);
	if (entry) {
		entry.value = value;
	} else {
		s.entries.push({ key, value });
	}
}

// ── View ──────────────────────────────────────────────────────────────────────

class UrlFileView extends TextFileView {
	icon = 'globe';
	private ini: ParsedIni = { sections: [] };

	getViewType(): string { return VIEW_TYPE_URL; }
	getDisplayText(): string { return this.file?.basename ?? 'URL File'; }
	getViewData(): string { return serializeIni(this.ini); }

	setViewData(data: string, _clear: boolean): void {
		this.ini = parseIni(data);
		this.render();
	}

	clear(): void { this.contentEl.empty(); }

	private get urlValue(): string {
		return iniGet(this.ini, 'InternetShortcut', 'URL');
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('url-preview-root');

		const card = contentEl.createDiv({ cls: 'url-preview-card' });

		// Editable fields
		const fields = card.createDiv({ cls: 'url-preview-fields' });

		this.buildField(fields, 'URL', this.urlValue, true, v => {
			iniSet(this.ini, 'InternetShortcut', 'URL', v);
			this.requestSave();
			this.render();
		});

		// Action buttons
		const actions = card.createDiv({ cls: 'url-preview-card-actions' });

		const openDefaultBtn = actions.createEl('button', {
			cls: 'url-preview-btn url-preview-action-btn',
			title: 'Open in default app',
		});
		setIcon(openDefaultBtn, 'external-link');
		openDefaultBtn.createSpan({ text: 'Open in default app' });
		openDefaultBtn.addEventListener('click', () => this.openInDefaultApp());

		if (this.isWebViewerEnabled()) {
			const openWebViewerBtn = actions.createEl('button', {
				cls: 'url-preview-btn url-preview-action-btn',
				title: 'Open in web viewer',
			});
			setIcon(openWebViewerBtn, 'app-window');
			openWebViewerBtn.createSpan({ text: 'Open in web viewer' });
			openWebViewerBtn.addEventListener('click', () => this.openInWebViewer());
		}

		const convertBtn = actions.createEl('button', {
			cls: 'url-preview-btn url-preview-action-btn',
			title: 'Convert to Markdown note',
		});
		setIcon(convertBtn, 'notebook-text');
		convertBtn.createSpan({ text: 'Convert to .md' });
		convertBtn.addEventListener('click', () => this.convertToMarkdown());
	}

	private getValidatedUrl(): string | null {
		const url = this.urlValue.trim();
		if (!url) {
			new Notice('URL Preview: no URL found in file.');
			return null;
		}
		try { new URL(url); } catch {
			new Notice(`URL Preview: malformed URL — ${url}`);
			return null;
		}
		return url;
	}

	private openInDefaultApp(): void {
		const file = this.file;
		if (!file) return;

		if (!Platform.isDesktopApp) {
			new Notice('URL Preview: opening in the default app is only supported on desktop.');
			return;
		}

		this.app.openWithDefaultApp(file.path);
	}

	private isWebViewerEnabled(): boolean {
		const internalPlugins = (this.app as any).internalPlugins;
		return internalPlugins?.plugins?.['webviewer']?.enabled === true;
	}

	private async openInWebViewer(): Promise<void> {
		const url = this.getValidatedUrl();
		if (!url) return;
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: 'webviewer',
			state: { url, navigate: true },
			active: true,
		});
	}

	private async convertToMarkdown(): Promise<void> {
		const file = this.file;
		if (!file) return;

		const url = this.urlValue.trim();
		const mdPath = file.path.replace(/\.url$/i, '.md');

		const existing = this.app.vault.getAbstractFileByPath(mdPath);
		if (existing instanceof TFile) {
			new Notice(`File already exists: ${mdPath}`);
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(existing);
			return;
		}

		const content = url
			? `---\nsource: ${url}\n---\n`
			: `---\n---\n`;

		const newFile = await this.app.vault.create(mdPath, content);
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(newFile);
		await this.app.fileManager.trashFile(file);
		new Notice(`Converted to ${newFile.basename}.md`);
	}

	private buildField(
		container: HTMLElement,
		label: string,
		value: string,
		isLink: boolean,
		onSave: (val: string) => void,
	): void {
		const row = container.createDiv({ cls: 'url-preview-field' });

		const valueWrap = row.createDiv({ cls: 'url-preview-value-wrap' });
		const displayEl = valueWrap.createDiv({ cls: 'url-preview-display' });
		this.renderDisplayValue(displayEl, value, isLink);

		const editBtn = row.createEl('button', {
			cls: 'url-preview-edit-btn',
			title: `Edit ${label}`,
		});
		setIcon(editBtn, 'pencil');

		editBtn.addEventListener('click', () => {
			this.activateInlineEditor(valueWrap, displayEl, editBtn, value, onSave);
		});
	}

	private renderDisplayValue(el: HTMLElement, value: string, isLink: boolean): void {
		if (!value) {
			el.createEl('span', { text: '—', cls: 'url-preview-empty' });
			return;
		}
		if (isLink) {
			const a = el.createEl('a', {
				text: value,
				cls: 'url-preview-url-link',
				href: '#',
			});
			a.addEventListener('click', e => {
				e.preventDefault();
				window.open(value, '_blank', 'noopener,noreferrer');
			});
		} else {
			el.createEl('span', { text: value, cls: 'url-preview-text' });
		}
	}

	private activateInlineEditor(
		valueWrap: HTMLElement,
		displayEl: HTMLElement,
		editBtn: HTMLButtonElement,
		currentValue: string,
		onSave: (val: string) => void,
	): void {
		displayEl.hide();
		editBtn.hide();

		const editEl = valueWrap.createDiv({ cls: 'url-preview-editor' });
		const input = editEl.createEl('input', {
			cls: 'url-preview-input',
			type: 'text',
			value: currentValue,
		});
		const actions = editEl.createDiv({ cls: 'url-preview-actions' });
		const saveBtn = actions.createEl('button', { text: 'Save', cls: 'url-preview-btn mod-cta' });
		const cancelBtn = actions.createEl('button', { text: 'Cancel', cls: 'url-preview-btn' });

		input.focus();
		input.select();

		const save = () => onSave(input.value.trim());
		const cancel = () => {
			editEl.remove();
			displayEl.show();
			editBtn.show();
		};

		saveBtn.addEventListener('click', save);
		cancelBtn.addEventListener('click', cancel);
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') save();
			if (e.key === 'Escape') cancel();
		});
	}
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default class UrlPreviewPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_URL, leaf => new UrlFileView(leaf));
		this.registerExtensions(['url'], VIEW_TYPE_URL);
		this.app.workspace.onLayoutReady(() => {
			this.attachExplorerDblClick();
		});
	}

	private attachExplorerDblClick(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
			this.registerDomEvent(
				(leaf.view as any).containerEl as HTMLElement,
				'dblclick',
				(evt: MouseEvent) => {
					const navItem = (evt.target as HTMLElement)
						.closest<HTMLElement>('.nav-file-title[data-path]');
					if (!navItem) return;
					const path = navItem.dataset['path'];
					if (path?.endsWith('.url')) this.openUrlFromFile(path);
				}
			);
		}
	}

	private async openUrlFromFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.cachedRead(file);
		const url = iniGet(parseIni(content), 'InternetShortcut', 'URL').trim();

		if (!url) {
			new Notice('URL Preview: no URL found in file.');
			return;
		}

		try { new URL(url); } catch {
			new Notice(`URL Preview: malformed URL — ${url}`);
			return;
		}

		window.open(url, '_blank', 'noopener,noreferrer');
	}

	async onunload(): Promise<void> {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_URL);
	}
}
