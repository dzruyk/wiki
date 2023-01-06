const stream = require('stream')
const Promise = require('bluebird')
const pipeline = Promise.promisify(stream.pipeline)
const _ = require('lodash')

/* global WIKI */

module.exports = {
  async activate() {
    if (WIKI.config.db.type !== 'sqlite') {
      throw new WIKI.Error.SearchActivationFailed('Must use Sqlite3 database to activate this engine!')
    }
    let opts = await WIKI.models.knex.schema.raw('PRAGMA compile_options')
    if (!_.find(opts, { compile_options: 'ENABLE_FTS5' })) {
      throw new WIKI.Error.SearchActivationFailed('Sqlite3 must have FTS5 module!')
    }
  },
  async deactivate() {
    WIKI.logger.info(`(SEARCH/SQLITE3) Dropping index tables...`)
    await WIKI.models.knex.schema.dropTable('fts5_pages_vector')
    WIKI.logger.info(`(SEARCH/SQLITE3) Index tables have been dropped.`)
  },
  /**
   * INIT
   */
  async init() {
    WIKI.logger.info(`(SEARCH/SQLITE3) Initializing...`)

    // -> Create Search Index
    const indexExists = await WIKI.models.knex.schema.hasTable('fts5_pages_vector')
    if (!indexExists) {
      WIKI.logger.info(`(SEARCH/SQLITE3) Creating Pages Vector table...`)
      await WIKI.models.knex.raw('create virtual table fts5_pages_vector using fts5(tokenize=unicode61, path, locale, title,description,content)')
    }
    WIKI.logger.info(`(SEARCH/SQLITE3) Initialization completed.`)
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, opts) {
    try {
      let qry = `
        SELECT rowid as id, path, locale, title, description
        FROM "fts5_pages_vector"
        WHERE content MATCH ?
        ORDER BY rank
      `
      let qryParams = [ q ]

      const results = await WIKI.models.knex.raw(qry, qryParams)
      return {
        results,
        suggestions: [],
        totalHits: results.length,
      }
    } catch (err) {
      WIKI.logger.warn('Search Engine Error:')
      WIKI.logger.warn(err)
    }
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(page) {
    await WIKI.models.knex.raw(`
      INSERT INTO "fts5_pages_vector" (path, locale, title, description, content) VALUES (
        ?, ?, ?, ?, ?
      )
    `, [page.path, page.localeCode, page.title, page.description, page.safeContent])
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    await WIKI.models.knex.raw(`
      UPDATE "fts5_pages_vector" SET
        title = ?,
        description = ?,
        content = ?
        WHERE path = ? AND locale = ?
    `, [page.title, page.description, page.safeContent,  page.path, page.localeCode])
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    await WIKI.models.knex('fts5_pages_vector').where({
      locale: page.localeCode,
      path: page.path
    }).del().limit(1)
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    await WIKI.models.knex('fts5_pages_vector').where({
      locale: page.localeCode,
      path: page.path
    }).update({
      locale: page.destinationLocaleCode,
      path: page.destinationPath
    })
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    WIKI.logger.info(`(SEARCH/SQLITE3) Rebuilding Index...`)
    await WIKI.models.knex('fts5_pages_vector').truncate()

    await pipeline(
      WIKI.models.knex.column('path', 'localeCode', 'title', 'description', 'render').select().from('pages').where({
        isPublished: true,
        isPrivate: false
      }).stream(),
      new stream.Transform({
        objectMode: true,
        transform: async (page, enc, cb) => {
          const content = WIKI.models.pages.cleanHTML(page.render)
          await WIKI.models.knex.raw(`
            INSERT INTO "fts5_pages_vector" (path, locale, title, description, content) VALUES (
              ?, ?, ?, ?, ?
            )
          `, [page.path, page.localeCode, page.title, page.description, content])
          cb()
        }
      })
    )
    WIKI.logger.info(`(SEARCH/SQLITE3) Index rebuilt successfully.`)
  }
}
