// only remove the thing if it's a symlink into a specific folder.
// This is a very common use-case of npm's, but not so common elsewhere.

module.exports = gentlyRm

var npm = require('../npm.js')
var log = require('npmlog')
var resolve = require('path').resolve
var dirname = require('path').dirname
var lstat = require('graceful-fs').lstat
var readlink = require('graceful-fs').readlink
var isInside = require('path-is-inside')
var vacuum = require('fs-vacuum')
var some = require('async-some')
var asyncMap = require('slide').asyncMap
var normalize = require('path').normalize
var readCmdShim = require('read-cmd-shim')
var iferr = require('iferr')

function gentlyRm (target, gently, base, cb) {
  if (!cb) {
    cb = base
    base = undefined
  }

  if (!cb) {
    cb = gently
    gently = false
  }

  log.silly(
    'gentlyRm',
    target,
    'is being', gently ? 'gently removed' : 'purged',
    base ? 'from base ' + base : ''
  )

  // never rm the root, prefix, or bin dirs
  //
  // globals included because of `npm link` -- as far as the package requesting
  // the link is concerned, the linked package is always installed globally
  var prefixes = [
    npm.prefix,
    npm.globalPrefix,
    npm.dir,
    npm.root,
    npm.globalDir,
    npm.bin,
    npm.globalBin
  ]

  var targetPath = normalize(resolve(npm.prefix, target))
  if (prefixes.indexOf(targetPath) !== -1) {
    log.verbose('gentlyRm', targetPath, "is part of npm and can't be removed")
    return cb(new Error('May not delete: ' + targetPath))
  }
  var options = { log: log.silly.bind(log, 'vacuum-fs') }
  if (npm.config.get('force') || !gently) options.purge = true
  if (base) options.base = normalize(resolve(npm.prefix, base))
  if (!gently) {
    log.verbose('gentlyRm', "don't care about contents; nuking", targetPath)
    return vacuum(targetPath, options, cb)
  }

  var parent = options.base = normalize(base ? resolve(npm.prefix, base) : npm.prefix)

  follow(targetPath, function (targetDest) {
    // is the parent directory managed by npm?
    log.silly('gentlyRm', 'verifying', parent, 'is an npm working directory')
    some(prefixes, isManaged(parent), function (er, parentManaged) {
      if (er) return cb(er)

      if (!parentManaged) {
        log.error('gentlyRm', 'containing path', parent, "isn't under npm's control")
        return clobberFail(targetPath, parent, cb)
      }
      log.silly('gentlyRm', 'containing path', parent, "is under npm's control, in", parentManaged)

      // is the target directly contained within the (now known to be
      // managed) parent?
      if (isInside(targetPath, parent)) {
        log.silly('gentlyRm', 'deletion target', targetPath, 'is under', parent)
        log.verbose('gentlyRm', 'vacuuming from', targetPath, 'up to', parent)
        options.base = parent
        return vacuum(targetPath, options, cb)
      }
      log.silly('gentlyRm', targetDest, 'is not under', parent)

      // the target isn't directly within the parent, but is it itself managed?
      log.silly('gentlyRm', 'verifying', targetDest, 'is an npm working directory')
      some(prefixes, isManaged(targetDest), function (er, targetDestManaged) {
        if (er) return cb(er)

        if (targetDestManaged) {
          log.silly('gentlyRm', targetPath, "is under npm's control, in", targetDestManaged)
          if (isInside(targetDest, parent)) {
            log.silly('gentlyRm', targetDest, 'is controlled by', parent)
            options.base = targetDestManaged
            log.verbose('gentlyRm', 'removing', targetPath, 'with base', options.base)
            return vacuum(targetPath, options, cb)
          } else if (targetPath !== targetDest) {
            log.warn('gentlyRm', 'not removing', targetPath, "as it wasn't installed by", parent)
            return cb()
          }
        }
        log.verbose('gentlyRm', targetPath, "is not under npm's control")

        // the target isn't managed directly, but maybe it's a link...
        log.silly('gentlyRm', 'checking to see if', targetPath, 'is a link')
        readLinkOrShim(targetPath, function (er, link) {
          if (er) {
            // race conditions are common when unbuilding
            if (er.code === 'ENOENT') return cb(null)
            return cb(er)
          }

          if (!link) {
            log.error('gentlyRm', targetPath, 'is outside', parent, 'and not a link')
            return clobberFail(targetPath, parent, cb)
          }

          // ...and maybe the link source, when read...
          log.silly('gentlyRm', targetPath, 'is a link')
          // ...is inside the managed parent
          var source = resolve(dirname(targetPath), link)
          if (isInside(source, parent)) {
            log.silly('gentlyRm', source, 'symlink target', targetPath, 'is inside', parent)
            log.verbose('gentlyRm', 'vacuuming', targetPath)
            return vacuum(targetPath, options, cb)
          }

          log.error('gentlyRm', source, 'symlink target', targetPath, 'is not controlled by npm', parent)
          return clobberFail(target, parent, cb)
        })
      })
    })
  })
}

var resolvedPaths = {}
function isManaged (target) {
  return function predicate (path, cb) {
    if (!path) {
      log.verbose('isManaged', 'no path passed for target', target)
      return cb(null, false)
    }

    asyncMap([path, target], resolveSymlink, function (er, results) {
      if (er) {
        if (er.code === 'ENOENT') return cb(null, false)

        return cb(er)
      }

      var path = results[0]
      var target = results[1]
      var inside = isInside(target, path)
      if (!inside) log.silly('isManaged', target, 'is not inside', path)

      return cb(null, inside && path)
    })
  }

  function resolveSymlink (toResolve, cb) {
    var resolved = resolve(npm.prefix, toResolve)

    // if the path has already been memoized, return immediately
    var cached = resolvedPaths[resolved]
    if (cached) return cb(null, cached)

    // otherwise, check the path
    readLinkOrShim(resolved, function (er, source) {
      if (er) return cb(er)

      // if it's not a link, cache & return the path itself
      if (!source) {
        resolvedPaths[resolved] = resolved
        return cb(null, resolved)
      }

      // otherwise, cache & return the link's source
      resolved = resolve(resolved, source)
      resolvedPaths[resolved] = resolved
      cb(null, resolved)
    })
  }
}

function clobberFail (target, root, cb) {
  var er = new Error('Refusing to delete: ' + target + ' not in ' + root)
  er.code = 'EEXIST'
  er.path = target
  return cb(er)
}

function readLinkOrShim (path, cb) {
  lstat(path, iferr(cb, function (stat) {
    if (stat.isSymbolicLink()) {
      readlink(path, cb)
    } else {
      readCmdShim(path, function (er, source) {
        if (!er) return cb(null, source)
        // lstat wouldn't return an error on these, so we don't either.
        if (er.code === 'ENOTASHIM' || er.code === 'EISDIR') {
          return cb(null, null)
        } else {
          return cb(er)
        }
      })
    }
  }))
}

function follow (path, cb) {
  readLinkOrShim(path, function (er, source) {
    if (!source) return cb(path)
    cb(normalize(resolve(dirname(path), source)))
  })
}
