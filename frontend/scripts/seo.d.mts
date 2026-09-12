import type { Plugin } from 'vite'
import type { View } from '../src/types.ts'

export function renderSeoHead(view: View, siteUrl: string | null): string
export function renderInitialContent(view: View): string
export function renderRouteHtml(html: string, view: View, siteUrl: string | null): string
export function renderRobots(siteUrl: string | null): string
export function renderSitemap(siteUrl: string | null): string | null
export function seoPlugin(): Plugin
