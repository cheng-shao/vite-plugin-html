import type { ResolvedConfig, PluginOption, TransformResult } from 'vite'
import type { InjectOptions, PageOption, Pages, UserOptions } from './typing'
import { render } from 'ejs'
import { cleanUrl, isDirEmpty, loadEnv } from './utils'
import { htmlFilter } from './utils/createHtmlFilter'
import { mergeConfig, normalizePath } from 'vite'
import { parse } from 'node-html-parser'
import fse from 'fs-extra'
import { resolve, dirname, basename } from 'pathe'
import fg from 'fast-glob'
import consola from 'consola'
import { dim } from 'colorette'
import history from 'connect-history-api-fallback'

const DEFAULT_TEMPLATE = 'index.html'
const ignoreDirs = ['.', '', '/']

const bodyInjectRE = /<\/body>/

export function createPlugin(userOptions: UserOptions = {}): PluginOption {
  const {
    entry,
    template = DEFAULT_TEMPLATE,
    pages = [],
    verbose = false,
  } = userOptions

  let viteConfig: ResolvedConfig
  let env: Record<string, any> = {}

  return {
    name: 'vite:html',
    enforce: 'pre',
    configResolved(resolvedConfig) {
      viteConfig = resolvedConfig
      env = loadEnv(viteConfig.mode, viteConfig.root, '')
    },
    config(conf) {
      const input = createInput(userOptions, conf as unknown as ResolvedConfig)
      if (input) {
        return {
          build: {
            rollupOptions: {
              input,
            },
          },
        }
      }
    },

    configureServer(server) {
      server.middlewares.use(
        history({
          disableDotRule: undefined,
          htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
        }),
      )
      server.middlewares.use(async (req, res, next) => {
        const url = cleanUrl(req.url || '')
        const base = viteConfig.base
        const excludeBaseUrl = url.replace(base, '/')

        if (!htmlFilter(url) && excludeBaseUrl !== '/') {
          return next()
        }

        try {
          const htmlName =
            excludeBaseUrl === '/' ? DEFAULT_TEMPLATE : url.replace('/', '')

          const page = getPage(userOptions, htmlName, viteConfig)
          const { injectOptions = {} } = page
          let html = await getHtmlInPages(page, viteConfig.root)
          html = await renderHtml(html, {
            injectOptions,
            viteConfig,
            env,
            entry: page.entry || entry,
            verbose,
          })
          html = await server.transformIndexHtml?.(url, html, req.originalUrl)
          res.end(html)
        } catch (e) {
          consola.log(e)
        }
      })
    },
    transform(code, id): Promise<TransformResult> | TransformResult {
      if (viteConfig.command === 'build' && htmlFilter(id)) {
        const htmlName = id.match('[^/]+(?!.*/)')?.[0] ?? DEFAULT_TEMPLATE

        const page = getPage(userOptions, htmlName, viteConfig)
        const { injectOptions = {} } = page
        return getHtmlInPages(page, viteConfig.root).then((html) => {
          return renderHtml(html, {
            injectOptions,
            viteConfig,
            env,
            entry: page.entry || entry,
            verbose,
          }).then((resultHtml) => {
            return {
              code: resultHtml,
              map: null,
            }
          })
        })
      }

      return {
        code,
        map: null,
      }
    },
    async closeBundle() {
      const outputDirs: string[] = []

      if (isMpa(viteConfig) || pages.length) {
        for (const page of pages) {
          const dir = dirname(page.template)
          if (!ignoreDirs.includes(dir)) {
            outputDirs.push(dir)
          }
        }
      } else {
        const dir = dirname(template)
        if (!ignoreDirs.includes(dir)) {
          outputDirs.push(dir)
        }
      }
      const cwd = resolve(viteConfig.root, viteConfig.build.outDir)
      const htmlFiles = await fg(
        outputDirs.map((dir) => `${dir}/*.html`),
        { cwd: resolve(cwd), absolute: true },
      )

      await Promise.all(
        htmlFiles.map((file) =>
          fse.move(file, resolve(cwd, basename(file)), { overwrite: true }),
        ),
      )

      const htmlDirs = await fg(
        outputDirs.map((dir) => dir),
        { cwd: resolve(cwd), onlyDirectories: true, absolute: true },
      )
      await Promise.all(
        htmlDirs.map(async (item) => {
          const isEmpty = await isDirEmpty(item)
          if (isEmpty) {
            return fse.remove(item)
          }
        }),
      )
    },
  }
}

export function createInput(
  { pages = [], template = DEFAULT_TEMPLATE }: UserOptions,
  viteConfig: ResolvedConfig,
) {
  const input: Record<string, string> = {}
  if (isMpa(viteConfig) || pages?.length) {
    const templates = pages.map((page) => page.template)
    templates.forEach((temp) => {
      const file = basename(temp)
      const key = file.replace(/\.html/, '')
      input[key] = resolve(viteConfig.root, temp)
    })
    return input
  } else {
    const dir = dirname(template)
    if (ignoreDirs.includes(dir)) {
      return undefined
    } else {
      const file = basename(template)
      const key = file.replace(/\.html/, '')
      return {
        [key]: resolve(viteConfig.root, template),
      }
    }
  }
}

export async function renderHtml(
  html: string,
  config: {
    injectOptions: InjectOptions
    viteConfig: ResolvedConfig
    env: Record<string, any>
    entry?: string
    verbose?: boolean
  },
) {
  const { injectOptions, viteConfig, env, entry, verbose } = config
  const { data, ejsOptions } = injectOptions

  const ejsData: Record<string, any> = {
    ...(viteConfig?.env ?? {}),
    ...(viteConfig?.define ?? {}),
    ...(env || {}),
    ...data,
  }
  let result = await render(html, ejsData, ejsOptions)

  if (entry) {
    result = removeEntryScript(result, verbose)
    result = result.replace(
      bodyInjectRE,
      `<script type="module" src="${normalizePath(
        `/${entry}`,
      )}"></script>\n</body>`,
    )
  }
  return result
}

export function getPage(
  { pages = [], entry, template = DEFAULT_TEMPLATE, inject = {} }: UserOptions,
  name: string,
  viteConfig: ResolvedConfig,
) {
  let page: PageOption
  if (isMpa(viteConfig) || pages?.length) {
    page = getPageConfig(name, pages, DEFAULT_TEMPLATE)
  } else {
    page = createSpaPage(entry, template, inject)
  }
  return page
}

function isMpa(viteConfig: ResolvedConfig) {
  const input = viteConfig?.build?.rollupOptions?.input ?? undefined
  return typeof input !== 'string' && Object.keys(input || {}).length > 1
}

export function removeEntryScript(html: string, verbose = false) {
  if (!html) {
    return html
  }

  const root = parse(html)
  const scriptNodes = root.querySelectorAll('script[type=module]') || []
  const removedNode: string[] = []
  scriptNodes.forEach((item) => {
    removedNode.push(item.toString())
    item.parentNode.removeChild(item)
  })
  verbose &&
    removedNode.length &&
    consola.warn(`vite-plugin-html: Since you have already configured entry, ${dim(
      removedNode.toString(),
    )} is deleted. You may also delete it from the index.html.
        `)
  return root.toString()
}

export function createSpaPage(
  entry: string | undefined,
  template: string,
  inject: InjectOptions = {},
): PageOption {
  return {
    entry,
    filename: 'index.html',
    template: template,
    injectOptions: inject,
  }
}

export function getPageConfig(
  htmlName: string,
  pages: Pages,
  defaultPage: string,
): PageOption {
  const defaultPageOption: PageOption = {
    filename: defaultPage,
    template: `./${defaultPage}`,
  }
  const page = pages.filter((page) => page.filename === htmlName)?.[0]
  return page ?? defaultPageOption ?? undefined
}

export function getHtmlInPages(page: PageOption, root: string) {
  const htmlPath = getHtmlPath(page, root)
  return readHtml(htmlPath)
}

export function getHtmlPath(page: PageOption, root: string) {
  const { template } = page
  const templatePath = template.startsWith('.') ? template : `./${template}`
  return resolve(root, templatePath)
}

export async function readHtml(path: string) {
  if (!fse.pathExistsSync(path)) {
    throw new Error(`html is not exist in ${path}`)
  }
  return await fse.readFile(path).then((buffer) => buffer.toString())
}
