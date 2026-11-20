// JS helpers of the live write methods (crates/payload-mongo-live-write/src/helpers.rs evaluates this
// script once per env and keeps the object it returns). Each helper is ONE upstream expression of
// packages/db-mongodb/src/<method>.ts, written with upstream's own source text, so evaluation order,
// property reads, spreads, the iterator protocol and V8's error messages (`Model.create is not a
// function`, `Cannot destructure property 'collection' of 'undefined' ...`) are upstream's. No helper
// awaits: control flow, awaits and try/catch stay in Rust.
;(() => {
  'use strict'

  return {
    // ---- parameter destructuring patterns (same keys, order and defaults as upstream) ----
    createArgs: ({ collection: collectionSlug, customID, data, req, returning }) => [
      collectionSlug,
      customID,
      data,
      req,
      returning,
    ],
    createGlobalArgs: ({ slug: globalSlug, data, req, returning }) => [
      globalSlug,
      data,
      req,
      returning,
    ],
    createVersionArgs: ({
      autosave,
      collectionSlug,
      createdAt,
      parent,
      publishedLocale,
      req,
      returning,
      snapshot,
      updatedAt,
      versionData,
    }) => [
      autosave,
      collectionSlug,
      createdAt,
      parent,
      publishedLocale,
      req,
      returning,
      snapshot,
      updatedAt,
      versionData,
    ],
    createGlobalVersionArgs: ({
      autosave,
      createdAt,
      globalSlug,
      publishedLocale,
      req,
      returning,
      snapshot,
      updatedAt,
      versionData,
    }) => [
      autosave,
      createdAt,
      globalSlug,
      publishedLocale,
      req,
      returning,
      snapshot,
      updatedAt,
      versionData,
    ],
    updateOneArgs: ({
      id,
      collection: collectionSlug,
      data,
      locale,
      options: optionsArgs = {},
      req,
      returning,
      select,
      where: whereArg = {},
    }) => [id, collectionSlug, data, locale, optionsArgs, req, returning, select, whereArg],
    updateManyArgs: ({
      collection: collectionSlug,
      data,
      limit,
      locale,
      options: optionsArgs = {},
      req,
      returning,
      select,
      sort: sortArg,
      where,
    }) => [
      collectionSlug,
      data,
      limit,
      locale,
      optionsArgs,
      req,
      returning,
      select,
      sortArg,
      where,
    ],
    upsertArgs: ({ collection, data, locale, req, returning, select, where }) => [
      collection,
      data,
      locale,
      req,
      returning,
      select,
      where,
    ],
    updateGlobalArgs: ({
      slug: globalSlug,
      data,
      options: optionsArgs = {},
      req,
      returning,
      select,
    }) => [globalSlug, data, optionsArgs, req, returning, select],
    updateVersionArgs: ({
      id,
      collection: collectionSlug,
      locale,
      options: optionsArgs = {},
      req,
      returning,
      select,
      versionData,
      where,
    }) => [id, collectionSlug, locale, optionsArgs, req, returning, select, versionData, where],
    updateGlobalVersionArgs: ({
      id,
      global: globalSlug,
      locale,
      options: optionsArgs = {},
      req,
      returning,
      select,
      versionData,
      where,
    }) => [id, globalSlug, locale, optionsArgs, req, returning, select, versionData, where],
    updateJobsArgs: ({ id, data, limit, req, returning, sort: sortArg, where: whereArg }) => [
      id,
      data,
      limit,
      req,
      returning,
      sortArg,
      whereArg,
    ],
    deleteOneArgs: ({ collection: collectionSlug, req, returning, select, where }) => [
      collectionSlug,
      req,
      returning,
      select,
      where,
    ],
    deleteManyArgs: ({ collection: collectionSlug, req, where }) => [collectionSlug, req, where],
    deleteVersionsArgs: ({ collection: collectionSlug, globalSlug, locale, req, where }) => [
      collectionSlug,
      globalSlug,
      locale,
      req,
      where,
    ],

    // ---- object literals ----
    /** `{ id: { equals: id } }` */
    idWhere: (id) => ({ id: { equals: id } }),
    /** the spread part of `{ ...optionsArgs, session: await getSession(this, req), timestamps: false }`,
     * evaluated before the await like upstream (the engine defines `session` / `timestamps` after it) */
    spread: (optionsArgs) => ({ ...optionsArgs }),
    /** the rest of that literal after the await (`partial` is the engine's own copy: re-spreading it
     * performs no observable operation and keeps the key order) */
    finishOptions: (partial, session) => ({ ...partial, session, timestamps: false }),
    /** `{ session: await getSession(this, req), timestamps: false }` (the literal after the await) */
    sessionOptions: (session) => ({ session, timestamps: false }),
    /** updateOne / updateMany / updateJobs: upstream's operator assembly, verbatim */
    assembleUpdateOps: ($inc, $push, $addToSet, $pull, updateData) => {
      const updateOps = {}

      if (Object.keys($inc).length) {
        updateOps.$inc = $inc
      }
      if (Object.keys($push).length) {
        updateOps.$push = $push
      }
      if (Object.keys($addToSet).length) {
        updateOps.$addToSet = $addToSet
      }
      if (Object.keys($pull).length) {
        updateOps.$pull = $pull
      }
      if (Object.keys(updateOps).length) {
        updateOps.$set = updateData
        updateData = updateOps
      }
      return updateData
    },
    /** `{ ...baseOptions, lean: true, projection, returnDocument: 'after' }` */
    findOptionsAfter: (baseOptions, projection) => ({
      ...baseOptions,
      lean: true,
      projection,
      returnDocument: 'after',
    }),
    /** updateMany: `{ ...baseOptions, lean: true, projection }` */
    findOptionsLean: (baseOptions, projection) => ({ ...baseOptions, lean: true, projection }),
    /** updateJobs: `{ ...baseOptions, lean: true, returnDocument: 'after' }` */
    findOptionsJobs: (baseOptions) => ({ ...baseOptions, lean: true, returnDocument: 'after' }),
    /** createVersion / createGlobalVersion `const data = { ... }` */
    versionData: (
      autosave,
      createdAt,
      parent,
      publishedLocale,
      snapshot,
      updatedAt,
      versionData,
      hasParent,
    ) =>
      hasParent
        ? {
            autosave,
            createdAt,
            latest: true,
            parent,
            publishedLocale,
            snapshot,
            updatedAt,
            version: versionData,
          }
        : {
            autosave,
            createdAt,
            latest: true,
            publishedLocale,
            snapshot,
            updatedAt,
            version: versionData,
          },
    /** createVersion `const parentQuery = { $or: [{ parent: { $eq: data.parent } }] }` */
    parentQuery: (data) => ({
      $or: [
        {
          parent: {
            $eq: data.parent,
          },
        },
      ],
    }),

    // ---- calls on the models (`Model` captured by the method, like upstream's `const { Model }`) ----
    /** `Model.create([data], options)` */
    modelCreate: (Model, data, options) => Model.create([data], options),
    /** `[doc] = <value>` / `let [doc] = <value>` (iterator protocol) */
    first: (value) => {
      // `(0, value)`: V8 then describes the value in its TypeError ("number 5 is not iterable ..."),
      // like upstream's `[doc] = await Model.create(...)`, instead of naming the variable
      const [doc] = (0, value)
      return doc
    },
    /** createVersion's latest flip */
    versionLatestFlip: (Model, doc, parentQuery, options) =>
      Model.updateMany(
        {
          $and: [
            {
              _id: {
                $ne: doc._id,
              },
            },
            parentQuery,
            {
              latest: {
                $eq: true,
              },
            },
            {
              updatedAt: {
                $lt: new Date(doc.updatedAt),
              },
            },
          ],
        },
        { $unset: { latest: 1 } },
        options,
      ),
    /** createGlobalVersion's latest flip */
    globalVersionLatestFlip: (Model, doc, options) =>
      Model.updateMany(
        {
          $and: [
            {
              _id: {
                $ne: doc._id,
              },
            },
            {
              latest: {
                $eq: true,
              },
            },
          ],
        },
        { $unset: { latest: 1 } },
        options,
      ),
    /** `Model.updateOne(query, updateData, baseOptions)` */
    modelUpdateOne: (Model, query, updateData, baseOptions) =>
      Model.updateOne(query, updateData, baseOptions),
    /** `Model.updateOne({ globalType: globalSlug }, data, baseOptions)` */
    modelUpdateOneGlobal: (Model, globalSlug, data, baseOptions) =>
      Model.updateOne({ globalType: globalSlug }, data, baseOptions),
    /** `Model.findOneAndUpdate(query, updateData, findOptions)` */
    modelFindOneAndUpdate: (Model, query, updateData, findOptions) =>
      Model.findOneAndUpdate(query, updateData, findOptions),
    /** `Model.findOneAndUpdate({ globalType: globalSlug }, data, findOptions)` */
    modelFindOneAndUpdateGlobal: (Model, globalSlug, data, findOptions) =>
      Model.findOneAndUpdate({ globalType: globalSlug }, data, findOptions),
    /** updateJobs, limit === 1 */
    modelFindOneAndUpdateSorted: (Model, query, updateData, findOptions, returning, sort) =>
      Model.findOneAndUpdate(query, updateData, {
        ...findOptions,
        projection: returning === false ? { _id: 1 } : undefined,
        sort,
      }),
    /** `Model.updateMany(query, data, baseOptions)` */
    modelUpdateMany: (Model, query, data, baseOptions) =>
      Model.updateMany(query, data, baseOptions),
    /** `Model.find(query, {}, { ...findOptions, limit, projection: { _id: 1 }, sort })` */
    modelFindIDs: (Model, query, findOptions, limit, sort) =>
      Model.find(query, {}, { ...findOptions, limit, projection: { _id: 1 }, sort }),
    /** `Model.find(query, {}, { ...findOptions, sort })` */
    modelFindSorted: (Model, query, findOptions, sort) =>
      Model.find(query, {}, { ...findOptions, sort }),
    /** updateMany `query = { _id: { $in: documentsToUpdate.map((doc) => doc._id) } }` */
    documentsToUpdateQuery: (documentsToUpdate) => ({
      _id: { $in: documentsToUpdate.map((doc) => doc._id) },
    }),
    /** updateJobs `const candidateIDs = candidates.map((candidate) => candidate._id)` */
    candidateIDs: (candidates) => candidates.map((candidate) => candidate._id),
    /** `{ $and: [query, { _id: { $in: candidateIDs } }] }` */
    claimQuery: (query, candidateIDs) => ({
      $and: [query, { _id: { $in: candidateIDs } }],
    }),
    /** `{ _id: { $in: candidateIDs }, processingToken: { $eq: data.processingToken } }` */
    claimedJobsQuery: (candidateIDs, data) => ({
      _id: { $in: candidateIDs },
      processingToken: { $eq: data.processingToken },
    }),
    /** `{ _id: { $in: candidateIDs } }` */
    limitedUpdateQuery: (candidateIDs) => ({ _id: { $in: candidateIDs } }),
    /** `doc ? [doc] : []` */
    wrapDoc: (doc) => (doc ? [doc] : []),
    /** `Model.deleteOne(query, options)?.lean()` */
    modelDeleteOneLean: (Model, query, options) => Model.deleteOne(query, options)?.lean(),
    /** `Model.findOneAndDelete(query, options)?.lean()` */
    modelFindOneAndDeleteLean: (Model, query, options) =>
      Model.findOneAndDelete(query, options)?.lean(),
    /** deleteOne `{ projection: buildProjectionFromSelect(...), session: await getSession(this, req) }` */
    deleteOneOptions: (projection, session) => ({ projection, session }),
    /** deleteMany `Model.deleteMany(query, { session: await getSession(this, req) })` (the
     * literal after the await) */
    modelDeleteMany: (Model, query, session) => Model.deleteMany(query, { session }),
    /** `VersionsModel.deleteMany(query, { session })` */
    versionsModelDeleteMany: (VersionsModel, query, session) =>
      VersionsModel.deleteMany(query, { session }),

    // ---- calls on `this` (the adapter) ----
    /** create.ts's catch of an invalid `allowIDOnCreate` id */
    logInvalidID: function (data) {
      this.payload.logger.error(
        `It appears you passed ID to create operation data but it cannot be sanitized to ObjectID, value - ${JSON.stringify(data.id)}`,
      )
    },
    /** upsert.ts */
    upsertCall: function (collection, data, locale, req, returning, select, where) {
      return this.updateOne({
        collection,
        data,
        locale,
        options: { upsert: true },
        req,
        returning,
        select,
        where,
      })
    },
  }
})()
