/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `open-in-kodi` command */
  export type OpenInKodi = ExtensionPreferences & {}
  /** Preferences accessible in the `open-pull-request` command */
  export type OpenPullRequest = ExtensionPreferences & {}
  /** Preferences accessible in the `open-clipboard-pull-request` command */
  export type OpenClipboardPullRequest = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `open-in-kodi` command */
  export type OpenInKodi = {}
  /** Arguments passed to the `open-pull-request` command */
  export type OpenPullRequest = {
  /** GitHub pull request URL */
  "url": string
}
  /** Arguments passed to the `open-clipboard-pull-request` command */
  export type OpenClipboardPullRequest = {}
}

