/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

'use strict';

const path = require('path');

const del = require('del');
const gulp = require('gulp');
const commandLineArgs = require('command-line-args');

const gulpif = require('gulp-if');
const mergeStream = require('merge-stream');
const polymerBuild = require('polymer-build');

// Here we add tools that will be used to process our source files.
const babel = require('gulp-babel');
const babelPresetES2015 = require('babel-preset-es2015');
const babiliPreset = require('babel-preset-babili');
const cssSlam = require('css-slam').gulp;
const externalHelpersPlugin = require('babel-plugin-external-helpers');
const htmlMinifier = require('gulp-html-minifier');
const imagemin = require('gulp-imagemin');

// Build out the Polymer Project Config instance
const polymerProject = getProjectConfig(require('./polymer.json'), getArgs());

function runBuilds() {
  const mainBuildDirectoryName = 'build';
  const builds = polymerProject.config.builds || [];

  // Okay, so first thing we do is clear the build directory
  console.log(`Clearing ${mainBuildDirectoryName}${path.sep} directory...`);
  return del([mainBuildDirectoryName])
    .then(() => {
      return Promise.all(builds.map((options) => {
        // If no name is provided, write directly to the build/ directory.
        // If a build name is provided, write to that subdirectory.
        const buildName = options.name || 'default';
        const buildDirectory = path.join(mainBuildDirectoryName, buildName);

        return new Promise((resolve) => {
          console.log(`(${buildName}) Building...`);

          // Lets create some inline code splitters in case you need them later in your build.
          const sourcesStreamSplitter = new polymerBuild.HtmlSplitter();
          const dependenciesStreamSplitter = new polymerBuild.HtmlSplitter();
          const htmlSplitter = new polymerBuild.HtmlSplitter();

          // Let's start by getting your source files. These are all the files
          // in your `src/` directory, or those that match your polymer.json
          // "sources"  property if you provided one.
          const sourcesStream = polymerBuild.forkStream(polymerProject.sources())
          .pipe(gulpif(/\.(png|gif|jpg|svg)$/, imagemin()))

          // The `sourcesStreamSplitter` created above can be added here to
          // pull any inline styles and scripts out of their HTML files and
          // into seperate CSS and JS files in the build stream. Just be sure
          // to rejoin those files with the `.rejoin()` method when you're done.
          .pipe(sourcesStreamSplitter.split())

          // If you want to optimize, minify, compile, or otherwise process
          // any of your source code for production, you can do so here before
          // merging your sources and dependencies together.

          // Remember, you need to rejoin any split inline code when you're done.
          .pipe(sourcesStreamSplitter.rejoin());


          // Similarly, you can get your dependencies seperately and perform
          // any dependency-only optimizations here as well.
          const depsStream = polymerBuild.forkStream(polymerProject.dependencies())
            .pipe(dependenciesStreamSplitter.split())
            // Add any dependency optimizations here.
            .pipe(dependenciesStreamSplitter.rejoin());


          // Okay, now let's merge your sources & dependencies together into a single build stream.
          let buildStream = mergeStream(sourcesStream, depsStream)
            .pipe(htmlSplitter.split());

          // You can perform any optimizations across both sources and dependencies here.

          // compile ES6 JavaScript using babel
          if (options.js && options.js.compile) {
            buildStream = buildStream.pipe(gulpif(/^((?!(webcomponentsjs\/|webcomponentsjs\\)).)*\.js$/, babel({
              presets: [babelPresetES2015.buildPreset({}, {modules: false})],
              plugins: [externalHelpersPlugin],
            })));
          }

          // minify code (minify should always be the last transform)
          if (options.html && options.html.minify) {
            buildStream = buildStream.pipe(gulpif(/\.html$/, htmlMinifier({
              collapseWhitespace: true,
              removeComments: true,
            })));
          }
          if (options.css && options.css.minify) {
            buildStream = buildStream.pipe(gulpif(/\.css$/, cssSlam({stripWhitespace: true})))
              // TODO: Remove once CSS is being properly isolated by split() and rejoin()
              .pipe(gulpif(/\.html$/, cssSlam({stripWhitespace: true})));
          }
          if (options.js && options.js.minify) {
            buildStream = buildStream.pipe(gulpif(/^((?!(webcomponentsjs\/|webcomponentsjs\\)).)*\.js$/, babel({
              presets: [babiliPreset({}, {'simplifyComparisons': false})],
            })));
          }

          buildStream = buildStream.pipe(htmlSplitter.rejoin());

          const compiledToES5 = !!(options.js && options.js.compile);
          if (compiledToES5) {
            buildStream = buildStream.pipe(polymerProject.addBabelHelpersInEntrypoint())
                              .pipe(polymerProject.addCustomElementsEs5Adapter());
          }

          // This will bundle dependencies into your fragments so you can lazy load them.
          if (options.bundle) {
            const bundlerOptions = {
              rewriteUrlsInTemplates: true, //!polymerVersion.startsWith('2.') // TODO: Check polymer version
            };
            if (typeof options.bundle === 'object') {
              Object.assign(bundlerOptions, options.bundle);
            }
            buildStream = buildStream.pipe(polymerProject.bundler(bundlerOptions));
          }

          // Add prefetch links
          if (options.insertPrefetchLinks) {
            buildStream = buildStream.pipe(polymerProject.addPrefetchLinks());
          }

          // Update baseTag
          if (options.basePath) {
            let basePath = options.basePath === true ? buildName : options.basePath;
            if (!basePath.startsWith('/')) {
              basePath = '/' + basePath;
            }
            if (!basePath.endsWith('/')) {
              basePath = basePath + '/';
            }
            buildStream = buildStream.pipe(polymerProject.updateBaseTag(basePath));
          }

          // Now let's generate the HTTP/2 Push Manifest
          if (options.addPushManifest) {
            buildStream = buildStream.pipe(polymerProject.addPushManifest());
          }

          // Okay, time to pipe to the build directory
          // Finish the build stream by piping it into the final build directory.
          buildStream = buildStream.pipe(gulp.dest(buildDirectory));

          // waitFor the buildStream to complete
          resolve(waitFor(buildStream));
        }).then(() => {
          // Okay, now let's generate the Service Worker
          if (options.addServiceWorker) {
            const swPrecacheConfigPath = path.resolve(
              polymerProject.config.root,
              options.swPrecacheConfig || 'sw-precache-config.js');
            const swPrecacheConfig = require(swPrecacheConfigPath);

            console.log(`(${buildName}) Generating the Service Worker...`);
            return polymerBuild.addServiceWorker({
              project: polymerProject,
              buildRoot: buildDirectory,
              bundled: !!(options.bundle),
              swPrecacheConfig: swPrecacheConfig || undefined,
            });
          }
        }).then(() => {
          // You did it!
          console.log(`(${buildName}) Build complete!`);
        }).catch((err) => {
          console.log('err', err);
        });
      }));
    });
}
gulp.task('build', runBuilds);

/**
 * Process CLI Args
 *
 * @return {Object}
 */
function getArgs() {
  // Define CLI options
  const optionDefinitions = [
    {name: 'presets', type: String, multiple: true},
    {name: 'add-service-worker', type: Boolean},
    {name: 'bundle', type: Boolean},
    {name: 'css-minify', type: Boolean},
    {name: 'html-minify', type: Boolean},
    {name: 'js-compile', type: Boolean},
    {name: 'js-minify', type: Boolean},
    {name: 'insert-prefetch-links', type: Boolean},
    {name: 'entrypoint', type: String},
    {name: 'shell', type: String},
    {name: 'fragment', type: String},
  ];

  // Get CLI options
  return commandLineArgs(optionDefinitions);
}
/**
 * Build out the PolymerProject based on polymer.json and CLI args
 *
 * @param {Object} polymerJson
 * @param {Object} cliArgs
 * @return {Object} - PolymerProject instance
 */
function getProjectConfig(polymerJson, cliArgs) {
  const allowedPresets = ['es5-bundled', 'es6-bundled', 'es6-unbundled'];

  if (Object.keys(cliArgs).length > 0) {
    if (cliArgs.presets) {
      // Check for allowed presets
      cliArgs.presets = cliArgs.presets.filter((preset) => allowedPresets.includes(preset));

      // Check for any pre-configured presets
      const configuredPresets = polymerJson.builds
        .filter((build) => build.preset)
        .map((build) => build.preset);

      // Use pre-configured else add preset
      polymerJson.builds = cliArgs.presets.map((preset) => {
        return configuredPresets.includes(preset) ?
          polymerJson.builds.find((build) => build.preset === preset) :
          {preset};
      });
    } else {
      // Create a custom build to use based on CLI flags
      polymerJson.builds = [{
        addServiceWorker: cliArgs['add-service-worker'] || false,
        insertPrefetchLinks: cliArgs['insert-prefetch-links'] || false,
        bundle: cliArgs.bundle,
        css: {
          minify: cliArgs['css-minify'] || false,
        },
        html: {
          minify: cliArgs['html-minify'] || false,
        },
        js: {
          compile: cliArgs['js-compile'] || false,
          minify: cliArgs['js-minify'] || false,
        },
      }];

      polymerJson.entrypoint = cliArgs.entrypoint || polymerJson.entrypoint;
      polymerJson.shell = cliArgs.shell || polymerJson.shell;
      if (cliArgs.fragment) {
        polymerJson.fragments = polymerJson.fragments.concat(cliArgs.fragment);
      }
    }
  }

  // Create Project Config
  return new polymerBuild.PolymerProject(polymerJson);
}
/**
 * Waits for the given ReadableStream
 * @param {ReadableStream} stream
 * @return {Promise}
 */
function waitFor(stream) {
  return new Promise((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}
