'use client'
import type { FilterOptionsResult, PaginatedDocs, ValueWithRelation, Where } from 'payload'

import { dequal } from 'dequal/lite'
import { formatAdminURL, wordBoundariesRegex } from 'payload/shared'
import * as qs from 'qs-esm'
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type { DocumentDrawerProps } from '../../elements/DocumentDrawer/types.js'
import type { ListDrawerProps } from '../../elements/ListDrawer/types.js'
import type { ReactSelectAdapterProps } from '../../elements/ReactSelect/types.js'
import type { GetResults, HasManyValueUnion, Option, RelationshipInputProps } from './types.js'

import { AddNewRelation } from '../../elements/AddNewRelation/index.js'
import { useDocumentDrawer } from '../../elements/DocumentDrawer/index.js'
import { useListDrawer } from '../../elements/ListDrawer/index.js'
import { ReactSelect } from '../../elements/ReactSelect/index.js'
import { RenderCustomComponent } from '../../elements/RenderCustomComponent/index.js'
import { FieldDescription } from '../../fields/FieldDescription/index.js'
import { FieldError } from '../../fields/FieldError/index.js'
import { FieldLabel } from '../../fields/FieldLabel/index.js'
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback.js'
import { useEffectEvent } from '../../hooks/useEffectEvent.js'
import { useAuth } from '../../providers/Auth/index.js'
import { useConfig } from '../../providers/Config/index.js'
import { useLocale } from '../../providers/Locale/index.js'
import { useTranslation } from '../../providers/Translation/index.js'
import { sanitizeFilterOptionsQuery } from '../../utilities/sanitizeFilterOptionsQuery.js'
import { fieldBaseClass } from '../shared/index.js'
import { createRelationMap } from './createRelationMap.js'
import { findOptionsByValue } from './findOptionsByValue.js'
import { optionsReducer } from './optionsReducer.js'
import { MultiValueLabel } from './select-components/MultiValueLabel/index.js'
import { SingleValue } from './select-components/SingleValue/index.js'
import './index.scss'

const baseClass = 'relationship'

export const RelationshipInput: React.FC<RelationshipInputProps> = (props) => {
  const {
    AfterInput,
    allowCreate = true,
    allowEdit = true,
    appearance = 'select',
    BeforeInput,
    className,
    description,
    Description,
    Error,
    filterOptions,
    hasMany,
    initialValue,
    isSortable = true,
    label,
    Label,
    localized,
    maxResultsPerRequest = 10,
    onChange,
    path,
    placeholder,
    readOnly,
    relationTo,
    required,
    showError,
    sortOptions,
    style,
    value,
  } = props

  const { config, getEntityConfig } = useConfig()

  const {
    routes: { api },
    serverURL,
  } = config

  const { i18n, t } = useTranslation()
  const { permissions } = useAuth()
  const { code: locale } = useLocale()

  const [currentlyOpenRelationship, setCurrentlyOpenRelationship] = useState<
    Parameters<ReactSelectAdapterProps['customProps']['onDocumentOpen']>[0]
  >({
    id: undefined,
    collectionSlug: undefined,
    hasReadPermission: false,
  })

  const [lastFullyLoadedRelation, setLastFullyLoadedRelation] = useState(-1)
  const [lastLoadedPage, setLastLoadedPage] = useState<Record<string, number>>({})
  const [errorLoading, setErrorLoading] = useState('')
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [enableWordBoundarySearch, setEnableWordBoundarySearch] = useState(false)
  const [menuIsOpen, setMenuIsOpen] = useState(false)
  const hasLoadedFirstPageRef = useRef(false)

  const [options, dispatchOptions] = useReducer(optionsReducer, [])

  const valueRef = useRef(value)
  // the line below seems odd
  // eslint-disable-next-line react-compiler/react-compiler -- TODO: fix this
  valueRef.current = value

  const [DocumentDrawer, , { isDrawerOpen, openDrawer }] = useDocumentDrawer({
    id: currentlyOpenRelationship.id,
    collectionSlug: currentlyOpenRelationship.collectionSlug,
  })

  // Filter selected values from displaying in the list drawer
  const listDrawerFilterOptions = useMemo<FilterOptionsResult>(() => {
    let newFilterOptions = filterOptions

    if (value) {
      const valuesByRelation = (hasMany === false ? [value] : value).reduce((acc, val) => {
        if (!acc[val.relationTo]) {
          acc[val.relationTo] = []
        }
        acc[val.relationTo].push(val.value)
        return acc
      }, {})

      ;(Array.isArray(relationTo) ? relationTo : [relationTo]).forEach((relation) => {
        newFilterOptions = {
          ...(newFilterOptions || {}),
          [relation]: {
            ...(typeof filterOptions?.[relation] === 'object' ? filterOptions[relation] : {}),
            ...(valuesByRelation[relation]
              ? {
                  id: {
                    not_in: valuesByRelation[relation],
                  },
                }
              : {}),
          },
        }
      })
    }

    return newFilterOptions
  }, [filterOptions, value, hasMany, relationTo])

  const [
    ListDrawer,
    ,
    { closeDrawer: closeListDrawer, isDrawerOpen: isListDrawerOpen, openDrawer: openListDrawer },
  ] = useListDrawer({
    collectionSlugs: relationTo,
    filterOptions: listDrawerFilterOptions,
  })

  const onListSelect = useCallback<NonNullable<ListDrawerProps['onSelect']>>(
    ({ collectionSlug, doc }) => {
      if (hasMany) {
        onChange([
          ...(Array.isArray(value) ? value : []),
          {
            relationTo: collectionSlug,
            value: doc.id,
          },
        ])
      } else if (hasMany === false) {
        onChange({
          relationTo: collectionSlug,
          value: doc.id,
        })
      }

      closeListDrawer()
    },
    [hasMany, onChange, closeListDrawer, value],
  )

  const openDrawerWhenRelationChanges = useRef(false)

  const getResults: GetResults = useCallback(
    async ({
      filterOptions,
      hasMany: hasManyArg,
      lastFullyLoadedRelation: lastFullyLoadedRelationArg,
      lastLoadedPage: lastLoadedPageArg,
      onSuccess,
      search: searchArg,
      sort,
      value: valueArg,
    }) => {
      if (!permissions) {
        return
      }
      const lastFullyLoadedRelationToUse =
        typeof lastFullyLoadedRelationArg !== 'undefined' ? lastFullyLoadedRelationArg : -1

      const relations = Array.isArray(relationTo) ? relationTo : [relationTo]
      const relationsToFetch =
        lastFullyLoadedRelationToUse === -1
          ? relations
          : relations.slice(lastFullyLoadedRelationToUse + 1)

      let resultsFetched = 0
      const relationMap = createRelationMap(
        hasManyArg === true
          ? {
              hasMany: true,
              relationTo,
              value: valueArg,
            }
          : {
              hasMany: false,
              relationTo,
              value: valueArg,
            },
      )

      if (!errorLoading) {
        await relationsToFetch.reduce(async (priorRelation, relation) => {
          const relationFilterOption = filterOptions?.[relation]

          let lastLoadedPageToUse
          if (search !== searchArg) {
            lastLoadedPageToUse = 1
          } else {
            lastLoadedPageToUse = lastLoadedPageArg[relation] + 1
          }
          await priorRelation

          if (relationFilterOption === false) {
            setLastFullyLoadedRelation(relations.indexOf(relation))
            return Promise.resolve()
          }

          if (resultsFetched < 10) {
            const collection = getEntityConfig({ collectionSlug: relation })
            const fieldToSearch = collection?.admin?.useAsTitle || 'id'
            let fieldToSort = collection?.defaultSort || 'id'
            if (typeof sortOptions === 'string') {
              fieldToSort = sortOptions
            } else if (sortOptions?.[relation]) {
              fieldToSort = sortOptions[relation]
            }

            const query: {
              [key: string]: unknown
              where: Where
            } = {
              depth: 0,
              draft: true,
              limit: maxResultsPerRequest,
              locale,
              page: lastLoadedPageToUse,
              select: {
                [fieldToSearch]: true,
              },
              sort: fieldToSort,
              where: {
                and: [
                  {
                    id: {
                      not_in: relationMap[relation],
                    },
                  },
                ],
              },
            }

            if (searchArg) {
              query.where.and.push({
                [fieldToSearch]: {
                  like: searchArg,
                },
              })
            }

            if (relationFilterOption && typeof relationFilterOption !== 'boolean') {
              query.where.and.push(relationFilterOption)
            }

            sanitizeFilterOptionsQuery(query.where)

            const response = await fetch(`${serverURL}${api}/${relation}`, {
              body: qs.stringify(query),
              credentials: 'include',
              headers: {
                'Accept-Language': i18n.language,
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Payload-HTTP-Method-Override': 'GET',
              },
              method: 'POST',
            })

            if (response.ok) {
              const data: PaginatedDocs<unknown> = await response.json()
              setLastLoadedPage((prevState) => {
                return {
                  ...prevState,
                  [relation]: lastLoadedPageToUse,
                }
              })

              if (!data.nextPage) {
                setLastFullyLoadedRelation(relations.indexOf(relation))
              }

              if (data.docs.length > 0) {
                resultsFetched += data.docs.length

                dispatchOptions({
                  type: 'ADD',
                  collection,
                  config,
                  docs: data.docs,
                  i18n,
                  sort,
                })
              }
            } else if (response.status === 403) {
              setLastFullyLoadedRelation(relations.indexOf(relation))
              dispatchOptions({
                type: 'ADD',
                collection,
                config,
                docs: [],
                i18n,
                ids: relationMap[relation],
                sort,
              })
            } else {
              setErrorLoading(t('error:unspecific'))
            }
          }
        }, Promise.resolve())

        if (typeof onSuccess === 'function') {
          onSuccess()
        }
      }
    },
    [
      permissions,
      relationTo,
      errorLoading,
      search,
      getEntityConfig,
      sortOptions,
      maxResultsPerRequest,
      locale,
      serverURL,
      api,
      i18n,
      config,
      t,
    ],
  )

  const updateSearch = useDebouncedCallback<{ search: string } & HasManyValueUnion>(
    ({ hasMany: hasManyArg, search: searchArg, value }) => {
      void getResults({
        filterOptions,
        lastLoadedPage: {},
        search: searchArg,
        sort: true,
        ...(hasManyArg === true
          ? {
              hasMany: hasManyArg,
              value,
            }
          : {
              hasMany: hasManyArg,
              value,
            }),
      })
      setSearch(searchArg)
    },
    300,
  )

  const handleInputChange = useCallback(
    (options: { search: string } & HasManyValueUnion) => {
      if (search !== options.search) {
        setLastLoadedPage({})
        updateSearch(options)
      }
    },
    [search, updateSearch],
  )

  const handleValueChange = useEffectEvent(({ hasMany: hasManyArg, value }: HasManyValueUnion) => {
    const relationMap = createRelationMap(
      hasManyArg === true
        ? {
            hasMany: hasManyArg,
            relationTo,
            value,
          }
        : {
            hasMany: hasManyArg,
            relationTo,
            value,
          },
    )

    void Object.entries(relationMap).reduce(async (priorRelation, [relation, ids]) => {
      await priorRelation

      const idsToLoad = ids.filter((id) => {
        return !options.find((optionGroup) =>
          optionGroup?.options?.find(
            (option) => option.value === id && option.relationTo === relation,
          ),
        )
      })

      if (idsToLoad.length > 0) {
        const query = {
          depth: 0,
          draft: true,
          limit: idsToLoad.length,
          locale,
          where: {
            id: {
              in: idsToLoad,
            },
          },
        }

        if (!errorLoading) {
          const response = await fetch(`${serverURL}${api}/${relation}`, {
            body: qs.stringify(query),
            credentials: 'include',
            headers: {
              'Accept-Language': i18n.language,
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Payload-HTTP-Method-Override': 'GET',
            },
            method: 'POST',
          })

          const collection = getEntityConfig({ collectionSlug: relation })
          let docs = []

          if (response.ok) {
            const data = await response.json()
            docs = data.docs
          }

          dispatchOptions({
            type: 'ADD',
            collection,
            config,
            docs,
            i18n,
            ids: idsToLoad,
            sort: true,
          })
        }
      }
    }, Promise.resolve())
  })

  const onSave = useCallback<DocumentDrawerProps['onSave']>(
    (args) => {
      dispatchOptions({
        type: 'UPDATE',
        collection: args.collectionConfig,
        config,
        doc: args.doc,
        i18n,
      })

      const docID = args.doc.id

      if (hasMany) {
        const currentValue = valueRef.current
          ? Array.isArray(valueRef.current)
            ? valueRef.current
            : [valueRef.current]
          : []

        const valuesToSet = currentValue.map((option: ValueWithRelation) => {
          return {
            relationTo: option.value === docID ? args.collectionConfig.slug : option.relationTo,
            value: option.value,
          }
        })

        onChange(valuesToSet)
      } else if (hasMany === false) {
        onChange({ relationTo: args.collectionConfig.slug, value: docID })
      }
    },
    [i18n, config, hasMany, onChange],
  )

  const onDuplicate = useCallback<DocumentDrawerProps['onDuplicate']>(
    (args) => {
      dispatchOptions({
        type: 'ADD',
        collection: args.collectionConfig,
        config,
        docs: [args.doc],
        i18n,
        sort: true,
      })

      if (hasMany) {
        onChange(
          valueRef.current
            ? (valueRef.current as ValueWithRelation[]).concat({
                relationTo: args.collectionConfig.slug,
                value: args.doc.id,
              })
            : null,
        )
      } else if (hasMany === false) {
        onChange({
          relationTo: args.collectionConfig.slug,
          value: args.doc.id,
        })
      }
    },
    [i18n, config, hasMany, onChange],
  )

  const onDelete = useCallback<DocumentDrawerProps['onDelete']>(
    (args) => {
      dispatchOptions({
        id: args.id,
        type: 'REMOVE',
        collection: args.collectionConfig,
        config,
        i18n,
      })

      if (hasMany) {
        onChange(
          valueRef.current
            ? (valueRef.current as ValueWithRelation[]).filter((option) => {
                return option.value !== args.id
              })
            : null,
        )
      } else {
        onChange(null)
      }

      return
    },
    [i18n, config, hasMany, onChange],
  )

  const filterOption = useCallback((item: Option, searchFilter: string) => {
    if (!searchFilter) {
      return true
    }
    const r = wordBoundariesRegex(searchFilter || '')
    // breaking the labels to search into smaller parts increases performance
    const breakApartThreshold = 250
    let labelString = String(item.label)
    // strings less than breakApartThreshold length won't be chunked
    while (labelString.length > breakApartThreshold) {
      // slicing by the next space after the length of the search input prevents slicing the string up by partial words
      const indexOfSpace = labelString.indexOf(' ', searchFilter.length)
      if (
        r.test(labelString.slice(0, indexOfSpace === -1 ? searchFilter.length : indexOfSpace + 1))
      ) {
        return true
      }
      labelString = labelString.slice(indexOfSpace === -1 ? searchFilter.length : indexOfSpace + 1)
    }
    return r.test(labelString.slice(-breakApartThreshold))
  }, [])

  const onDocumentOpen = useCallback<ReactSelectAdapterProps['customProps']['onDocumentOpen']>(
    ({ id, collectionSlug, hasReadPermission, openInNewTab }) => {
      if (openInNewTab) {
        if (hasReadPermission && id && collectionSlug) {
          const docUrl = formatAdminURL({
            adminRoute: config.routes.admin,
            path: `/collections/${collectionSlug}/${id}`,
          })

          window.open(docUrl, '_blank')
        }
      } else {
        openDrawerWhenRelationChanges.current = true

        setCurrentlyOpenRelationship({
          id,
          collectionSlug,
          hasReadPermission,
        })
      }
    },
    [config.routes.admin],
  )

  const getResultsEffectEvent: GetResults = useEffectEvent(async (args) => {
    return await getResults(args)
  })

  // When (`relationTo` || `filterOptions` || `locale`) changes, reset component
  // Note - effect should not run on first run
  useEffect(() => {
    // If the menu is open while filterOptions changes
    // due to latency of form state and fast clicking into this field,
    // re-fetch options
    if (hasLoadedFirstPageRef.current && menuIsOpen) {
      setIsLoading(true)
      void getResultsEffectEvent({
        filterOptions,
        lastLoadedPage: {},
        onSuccess: () => {
          hasLoadedFirstPageRef.current = true
          setIsLoading(false)
        },
        ...(hasMany === true
          ? {
              hasMany,
              value: valueRef.current as ValueWithRelation[],
            }
          : {
              hasMany,
              value: valueRef.current as ValueWithRelation,
            }),
      })
    }

    // If the menu is not open, still reset the field state
    // because we need to get new options next time the menu opens
    dispatchOptions({
      type: 'CLEAR',
      exemptValues: valueRef.current,
    })

    setLastFullyLoadedRelation(-1)
    setLastLoadedPage({})
  }, [relationTo, filterOptions, locale, path, menuIsOpen, hasMany])

  const prevValue = useRef(value)
  const isFirstRenderRef = useRef(true)
  // ///////////////////////////////////
  // Ensure we have an option for each value
  // ///////////////////////////////////
  useEffect(() => {
    if (isFirstRenderRef.current || !dequal(value, prevValue.current)) {
      handleValueChange(hasMany === true ? { hasMany, value } : { hasMany, value })
    }
    isFirstRenderRef.current = false
    prevValue.current = value
  }, [value, hasMany])

  // Determine if we should switch to word boundary search
  useEffect(() => {
    const relations = Array.isArray(relationTo) ? relationTo : [relationTo]
    const isIdOnly = relations.reduce((idOnly, relation) => {
      const collection = getEntityConfig({ collectionSlug: relation })
      const fieldToSearch = collection?.admin?.useAsTitle || 'id'
      return fieldToSearch === 'id' && idOnly
    }, true)
    setEnableWordBoundarySearch(!isIdOnly)
  }, [relationTo, getEntityConfig])

  useEffect(() => {
    if (openDrawerWhenRelationChanges.current) {
      openDrawer()
      openDrawerWhenRelationChanges.current = false
    }
  }, [openDrawer, currentlyOpenRelationship])

  const valueToRender = findOptionsByValue({ allowEdit, options, value })

  if (!Array.isArray(valueToRender) && valueToRender?.value === 'null') {
    valueToRender.value = null
  }

  return (
    <div
      className={[
        fieldBaseClass,
        baseClass,
        className,
        showError && 'error',
        errorLoading && 'error-loading',
        readOnly && `${baseClass}--read-only`,
        !readOnly && allowCreate && `${baseClass}--allow-create`,
      ]
        .filter(Boolean)
        .join(' ')}
      id={`field-${path.replace(/\./g, '__')}`}
      style={style}
    >
      <RenderCustomComponent
        CustomComponent={Label}
        Fallback={
          <FieldLabel label={label} localized={localized} path={path} required={required} />
        }
      />
      <div className={`${fieldBaseClass}__wrap`}>
        <RenderCustomComponent
          CustomComponent={Error}
          Fallback={<FieldError path={path} showError={showError} />}
        />
        {BeforeInput}
        {!errorLoading && (
          <div className={`${baseClass}__wrap`}>
            <ReactSelect
              backspaceRemovesValue={!(isDrawerOpen || isListDrawerOpen)}
              components={{
                MultiValueLabel,
                SingleValue,
                ...(appearance !== 'select' && { DropdownIndicator: null }),
              }}
              customProps={{
                disableKeyDown: isDrawerOpen || isListDrawerOpen,
                disableMouseDown: isDrawerOpen || isListDrawerOpen,
                onDocumentOpen,
                onSave,
              }}
              disabled={readOnly || isDrawerOpen || isListDrawerOpen}
              filterOption={enableWordBoundarySearch ? filterOption : undefined}
              getOptionValue={(option: ValueWithRelation) => {
                if (!option) {
                  return undefined
                }
                return hasMany && Array.isArray(relationTo)
                  ? `${option.relationTo}_${option.value}`
                  : (option.value as string)
              }}
              isLoading={appearance === 'select' && isLoading}
              isMulti={hasMany}
              isSearchable={appearance === 'select'}
              isSortable={isSortable}
              menuIsOpen={appearance === 'select' ? menuIsOpen : false}
              onChange={
                !readOnly
                  ? (selected) => {
                      if (hasMany) {
                        if (selected === null) {
                          onChange([])
                        } else {
                          onChange(selected as ValueWithRelation[])
                        }
                      } else if (hasMany === false) {
                        if (selected === null) {
                          onChange(null)
                        } else {
                          onChange(selected as ValueWithRelation)
                        }
                      }
                    }
                  : undefined
              }
              onInputChange={(newSearch) =>
                handleInputChange({
                  search: newSearch,
                  ...(hasMany === true
                    ? {
                        hasMany,
                        value,
                      }
                    : {
                        hasMany,
                        value,
                      }),
                })
              }
              onMenuClose={() => {
                setMenuIsOpen(false)
              }}
              onMenuOpen={() => {
                if (appearance === 'drawer') {
                  openListDrawer()
                } else if (appearance === 'select') {
                  setMenuIsOpen(true)
                  if (!hasLoadedFirstPageRef.current) {
                    setIsLoading(true)
                    void getResults({
                      filterOptions,
                      lastLoadedPage: {},
                      onSuccess: () => {
                        hasLoadedFirstPageRef.current = true
                        setIsLoading(false)
                      },
                      ...(hasMany === true
                        ? {
                            hasMany,
                            value,
                          }
                        : {
                            hasMany,
                            value,
                          }),
                    })
                  }
                }
              }}
              onMenuScrollToBottom={() => {
                void getResults({
                  filterOptions,
                  lastFullyLoadedRelation,
                  lastLoadedPage,
                  search,
                  sort: false,
                  ...(hasMany === true
                    ? {
                        hasMany,
                        value: initialValue,
                      }
                    : {
                        hasMany,
                        value: initialValue,
                      }),
                })
              }}
              options={options}
              placeholder={placeholder}
              showError={showError}
              value={valueToRender ?? null}
            />
            {!readOnly && allowCreate && (
              <AddNewRelation
                path={path}
                relationTo={relationTo}
                {...(hasMany === true
                  ? {
                      hasMany,
                      onChange,
                      value,
                    }
                  : {
                      hasMany,
                      onChange,
                      value,
                    })}
              />
            )}
          </div>
        )}
        {errorLoading && <div className={`${baseClass}__error-loading`}>{errorLoading}</div>}
        {AfterInput}
        <RenderCustomComponent
          CustomComponent={Description}
          Fallback={<FieldDescription description={description} path={path} />}
        />
      </div>
      {currentlyOpenRelationship.collectionSlug && currentlyOpenRelationship.hasReadPermission && (
        <DocumentDrawer onDelete={onDelete} onDuplicate={onDuplicate} onSave={onSave} />
      )}
      {appearance === 'drawer' && !readOnly && (
        <ListDrawer allowCreate={allowCreate} enableRowSelections={false} onSelect={onListSelect} />
      )}
    </div>
  )
}
