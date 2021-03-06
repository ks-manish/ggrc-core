/*
    Copyright (C) 2019 Google Inc.
    Licensed under http://www.apache.org/licenses/LICENSE-2.0 <see LICENSE file>
*/

import Spinner from 'spin.js';
import {
  isAdmin,
  getPageInstance,
} from './plugins/utils/current-page-utils';
import {
  getRole,
  isAuditor,
} from './plugins/utils/acl-utils';
import RefreshQueue from './models/refresh_queue';
import Permission from './permission';
import _ from 'lodash';
import {
  buildCountParams,
  batchRequests,
} from './plugins/utils/query-api-utils';
import Search from './models/service-models/search';
import modalModels from './models/modal-models';
import {isScopeModel} from './plugins/utils/models-utils';
import {reify, isReifiable} from './plugins/utils/reify-utils';
import Mappings from './models/mappers/mappings';
import {
  getFormattedLocalDate,
  formatDate,
} from './plugins/utils/date-utils';

// Chrome likes to cache AJAX requests for template.
let templateUrls = {};
let Mustache = can.Mustache;
$.ajaxPrefilter(function (options, originalOptions, jqXHR) {
  if (/\.templates$/.test(options.url)) {
    if (templateUrls[options.url]) {
      options.url = templateUrls[options.url];
    } else {
      templateUrls[options.url] = options.url += '?r=' + Math.random();
    }
  }
});

function getTemplatePath(url) {
  let match = url.match(/\/static\/(templates)\/(.*)\.stache/);
  return match && match[2];
}

// Check if the template is available in "GGRC.Templates", and if so,
//   short-circuit the request.

$.ajaxTransport('text', function (options, _originalOptions, _jqXHR) {
  let templatePath = getTemplatePath(options.url);
  let template = templatePath && GGRC.Templates[templatePath];
  if (template) {
    return {
      send: function (headers, completeCallback) {
        function done() {
          if (template) {
            completeCallback(200, 'success', {text: template});
          }
        }
        if (options.async) {
          // Use requestAnimationFrame where possible because we want
          // these to run as quickly as possible but still release
          // the thread.
          (window.requestAnimationFrame || window.setTimeout)(done, 0);
        } else {
          done();
        }
      },

      abort: function () {
        template = null;
      },
    };
  }
});

/**
 * Builds class name of two segments - prefix and computed value
 * @param  {String|computed} prefix class prefix
 * @param  {String|computed} compute some computed value
 * @param  {Object} [options={}] options
 * @param  {Object} [options.separator='-'] separator between prefix and comuted value
 * @param  {Object} [options.computeSeparator=''] separator which replaces whitespaces in computed value
 * @return {String} computed class string
 */
Mustache.registerHelper('addclass', function (prefix, compute, options = {}) {
  prefix = resolveComputed(prefix);
  let computeVal = resolveComputed(compute);
  let opts = options.hash || {};
  let separator = _.isString(opts.separator) ? opts.separator : '-';
  let computeSeparator = _.isString(opts.computeSeparator)
    ? opts.computeSeparator : '';
  let classSegment = _.trim(computeVal)
    .replace(/[\s\t]+/g, computeSeparator)
    .toLowerCase();

  return [prefix, classSegment].join(separator);
});

Mustache.registerHelper('if_equals', function (val1, val2, options) {
  let _val1;
  let _val2;
  function exec() {
    if (_val1 && val2 && options.hash && options.hash.insensitive) {
      _val1 = _val1.toLowerCase();
      _val2 = _val2.toLowerCase();
    }
    if (_val1 === _val2) return options.fn(options.contexts);
    else return options.inverse(options.contexts);
  }
  if (typeof val1 === 'function') {
    if (val1.isComputed) {
      val1.bind('change', function (ev, newVal) {
        _val1 = newVal;
        return exec();
      });
    }
    _val1 = val1.call(this);
  } else {
    _val1 = val1;
  }
  if (typeof val2 === 'function') {
    if (val2.isComputed) {
      val2.bind('change', function (ev, newVal) {
        _val2 = newVal;
        exec();
      });
    }
    _val2 = val2.call(this);
  } else {
    _val2 = val2;
  }

  return exec();
});

Mustache.registerHelper('in_array', function (needle, haystack, options) {
  needle = resolveComputed(needle);
  haystack = resolveComputed(haystack);

  return options[_.includes(haystack, needle) ?
    'fn' : 'inverse'](options.contexts);
});

// Resolve and return the first computed value from a list
Mustache.registerHelper('firstexist', function () {
  let args = can.makeArray(arguments).slice(0, arguments.length - 1); // ignore the last argument (some Can object)
  for (let i = 0; i < args.length; i++) {
    let v = resolveComputed(args[i]);
    if (v && v.length) {
      return v.toString();
    }
  }
  return '';
});

// Return the first value from a list that computes to a non-empty string
Mustache.registerHelper('firstnonempty', function () {
  let args = can.makeArray(arguments).slice(0, arguments.length - 1); // ignore the last argument (some Can object)
  for (let i = 0; i < args.length; i++) {
    let v = resolveComputed(args[i]);
    if (v !== null && v !== undefined && !!v.toString()
      .trim().replace(/&nbsp;|\s|<br *\/?>/g, '')) return v.toString();
  }
  return '';
});

Mustache.registerHelper('is_empty', (data, options) => {
  data = resolveComputed(data);
  const result = can.isEmptyObject(
    can.isPlainObject(data) ? data : data.attr()
  );
  return options[result ? 'fn' : 'inverse'](options.contexts);
});

// Like 'render', but doesn't serialize the 'context' object, and doesn't
// apply options.hash
Mustache.registerHelper('renderLive', function (template, context, options) {
  if (!options) {
    options = context;
    context = this;
  } else {
    options.contexts = options.contexts.add(context);
  }

  if (typeof context === 'function') {
    context = context();
  }

  if (typeof template === 'function') {
    template = template();
  }

  if (options.hash) {
    options.contexts = options.contexts.add(options.hash);
  }

  return can.view.render(template, options.contexts);
});

function deferRender(tagPrefix, funcs, deferred) {
  let hook;
  let tagName = tagPrefix.split(' ')[0];

  tagName = tagName || 'span';

  if (typeof funcs === 'function') {
    funcs = {done: funcs};
  }

  function hookup(element, parent) {
    let $element = $(element);
    let func = function () {
      let callback = deferred && deferred.state() === 'rejected' ?
        funcs.fail : funcs.done;
      let args = arguments;
      let compute = can.compute(function () {
        return callback.apply(this, args) || '';
      }, this);

      if (element.parentNode) {
        can.view.live.html(element, compute, parent);
      } else {
        $element.after(compute());
        if ($element.next().get(0)) {
          can.view.nodeLists.update($element.get(), $element.nextAll().get());
          $element.remove();
        }
      }
    };
    if (deferred) {
      deferred.done(func);
      if (funcs.fail) {
        deferred.fail(func);
      }
    } else {
      setTimeout(func, 13);
    }

    if (funcs.progress) {
      // You would think that we could just do $element.append(funcs.progress()) here
      //  but for some reason we have to hookup our own fragment.
      $element.append(can.view.hookup($('<div>')
        .html(funcs.progress())).html());
    }
  }

  hook = can.view.hook(hookup);
  return ['<', tagPrefix, ' ', hook, '>', '</', tagName, '>'].join('');
}

Mustache.registerHelper('using', function (options) {
  let refreshQueue = new RefreshQueue();
  let frame = new can.Map();
  let args = can.makeArray(arguments);
  let i;
  let arg;

  options = args.pop();

  if (options.hash) {
    for (i in options.hash) {
      if (options.hash.hasOwnProperty(i)) {
        arg = options.hash[i];
        arg = Mustache.resolve(arg);
        if (arg && isReifiable(arg)) {
          refreshQueue.enqueue(reify(arg));
          frame.attr(i, reify(arg));
        } else {
          frame.attr(i, arg);
        }
      }
    }
  }

  function finish() {
    return options.fn(options.contexts.add(frame));
  }

  return deferRender('span', finish, refreshQueue.trigger());
});

/**
 *  Helper for rendering date or datetime values in current local time
 *
 *  @param {boolean} hideTime - if set to true, render date only
 *  @return {String} - date or datetime string in the following format:
 *    * date: MM/DD/YYYY),
 *    * datetime (MM/DD/YYYY hh:mm:ss [PM|AM] [local timezone])
 */
Mustache.registerHelper('date', function (date, hideTime) {
  date = Mustache.resolve(date);
  return formatDate(date, hideTime);
});

/**
 *  Helper for rendering datetime values in current local time
 *
 *  @return {String} - datetime string in the following format:
 *  (MM/DD/YYYY hh:mm:ss [PM|AM] [local timezone])
 */
Mustache.registerHelper('dateTime', function (date) {
  date = Mustache.resolve(date);
  return getFormattedLocalDate(date);
});

/**
 * Checks permissions.
 * Usage:
 *  {{#is_allowed ACTION [ACTION2 ACTION3...] RESOURCE_TYPE_STRING context=CONTEXT_ID}} content {{/is_allowed}}
 *  {{#is_allowed ACTION RESOURCE_INSTANCE}} content {{/is_allowed}}
 */
let allowedActions = ['create', 'read', 'update', 'delete', '__GGRC_ADMIN__'];
Mustache.registerHelper('is_allowed', function (...args) {
  let actions = [];
  let resource;
  let resourceType;
  let contextUnset = {};
  let contextId = contextUnset;
  let contextOverride;
  let options = args[args.length - 1];
  let passed = true;

  // Resolve arguments
  args.forEach(function (arg, i) {
    while (typeof arg === 'function' && arg.isComputed) {
      arg = arg();
    }

    if (typeof arg === 'string' && allowedActions.includes(arg)) {
      actions.push(arg);
    } else if (typeof arg === 'string') {
      resourceType = arg;
    } else if (typeof arg === 'object' && arg instanceof can.Map) {
      resource = arg;
    }
  });
  if (options.hash && options.hash.hasOwnProperty('context')) {
    contextId = options.hash.context;
    if (typeof contextId === 'function' && contextId.isComputed) {
      contextId = contextId();
    }
    if (contextId && typeof contextId === 'object' && contextId.id) {
      // Passed in the context object instead of the context ID, so use the ID
      contextId = contextId.id;
    }
    //  Using `context=null` in templates, when `null` is not defined,
    //  causes `context_id` to be `""`.
    if (contextId === '' || contextId === undefined) {
      contextId = null;
    } else if (contextId === 'for' || contextId === 'any') {
      contextOverride = contextId;
      contextId = undefined;
    }
  }

  if (resourceType && contextId === contextUnset) {
    throw new Error(
      'If `resource_type` is a string, `context` must be explicit');
  }
  if (actions.length === 0) {
    throw new Error('Must specify at least one action');
  }

  if (resource) {
    resourceType = resource.constructor.model_singular;
    contextId = resource.context ? resource.context.id : null;
  }

  // Check permissions
  actions.forEach(function (action) {
    if (resource && Permission.is_allowed_for(action, resource)) {
      passed = true;
      return;
    }
    if (contextId !== undefined) {
      passed = passed && Permission.is_allowed(action, resourceType,
        contextId);
    }
    if (passed && contextOverride === 'for' && resource) {
      passed = passed && Permission.is_allowed_for(action, resource);
    } else if (passed && contextOverride === 'any' && resourceType) {
      passed = passed && Permission.is_allowed_any(action, resourceType);
    }
  });

  return passed ? options.fn(options.contexts || this) :
    options.inverse(options.contexts || this);
});

Mustache.registerHelper('any_allowed', function (action, data, options) {
  let passed = [];
  let hasPassed;
  data = resolveComputed(data);

  data.forEach(function (item) {
    passed.push(Permission.is_allowed_any(action, item.model_name));
  });
  hasPassed = passed.some(function (val) {
    return val;
  });
  return options[hasPassed ? 'fn' : 'inverse'](options.contexts || this);
});

Mustache.registerHelper('is_allowed_to_map',
  function (source, target, options) {
    //  For creating mappings, we only care if the user has update permission on
    //  source and/or target.
    //  - `source` must be a model instance
    //  - `target` can be the name of the target model or the target instance
    let canMap;

    source = resolveComputed(source);
    target = resolveComputed(target);
    canMap = Mappings.allowedToMap(source, target, options);

    if (canMap) {
      return options.fn(options.contexts || this);
    }
    return options.inverse(options.contexts || this);
  });

Mustache.registerHelper('is_allowed_to_map_task', (sourceType, options) => {
  const mappableTypes = ['Program', 'Regulation', 'Policy', 'Standard',
    'Contract', 'Requirement', 'Control', 'Objective', 'KeyReport',
    'OrgGroup', 'Vendor', 'AccessGroup', 'System', 'Process', 'DataAsset',
    'Product', 'ProductGroup', 'Project', 'Facility', 'Market', 'Metric',
    'TechnologyEnvironment'];
  sourceType = resolveComputed(sourceType);

  if (mappableTypes.includes(sourceType)) {
    return options.fn(options.contexts);
  }
  return options.inverse(options.contexts);
});

function resolveComputed(maybeComputed, alwaysResolve) {
  return (typeof maybeComputed === 'function'
    && (maybeComputed.isComputed || alwaysResolve)) ?
    resolveComputed(maybeComputed(), alwaysResolve) : maybeComputed;
}

Mustache.registerHelper('attach_spinner', function (spinOpts, styles) {
  spinOpts = Mustache.resolve(spinOpts);
  styles = Mustache.resolve(styles);
  spinOpts = typeof spinOpts === 'string' ? JSON.parse(spinOpts) : {};
  styles = typeof styles === 'string' ? styles : '';
  return function (el) {
    let spinner = new Spinner(spinOpts).spin();
    $(el).append($(spinner.el).attr('style',
      $(spinner.el).attr('style') + ';' + styles)).data('spinner', spinner);
  };
});

function localizeDate(date, options, tmpl, allowNonISO) {
  let formats = [
    'YYYY-MM-DD',
    'YYYY-MM-DDTHH:mm:ss',
    'YYYY-MM-DDTHH:mm:ss.SSSSSS',
  ];
  if (allowNonISO) {
    formats.push('MM/DD/YYYY', 'MM/DD/YYYY hh:mm:ss A');
  }
  if (!options) {
    return moment().format(tmpl);
  }
  date = resolveComputed(date);
  if (date) {
    if (typeof date === 'string') {
      // string dates are assumed to be in ISO format
      return moment.utc(date, formats, true)
        .format(tmpl);
    }
    return moment(new Date(date)).format(tmpl);
  }
  return '';
}

Mustache.registerHelper('localize_date', function (date, allowNonISO, options) {
  // allowNonIso was not passed
  if (!options) {
    options = allowNonISO;
    allowNonISO = false;
  }
  return localizeDate(date, options, 'MM/DD/YYYY', allowNonISO);
});

Mustache.registerHelper('normalizeLink', (value) => {
  let link = resolveComputed(value);
  if (link) {
    link = link.replace(/^(?!(?:\w+:)?\/)/, 'http://');
  }

  return link;
});

Mustache.registerHelper('lowercase', function (value, options) {
  value = resolveComputed(value) || '';
  return value.toLowerCase();
});

Mustache.registerHelper('is_dashboard', function (options) {
  return /dashboard/.test(window.location) ?
    options.fn(options.contexts) :
    options.inverse(options.contexts);
});

Mustache.registerHelper('is_dashboard_or_all', function (options) {
  return (/dashboard/.test(window.location) ||
    /objectBrowser/.test(window.location)) ?
    options.fn(options.contexts) :
    options.inverse(options.contexts);
});

Mustache.registerHelper('is_admin_page', (options) => {
  return isAdmin() ?
    options.fn(options.contexts) :
    options.inverse(options.contexts);
});

Mustache.registerHelper('current_user_is_admin', function (options) {
  if (Permission.is_allowed('__GGRC_ADMIN__')) {
    return options.fn(options.contexts);
  }
  return options.inverse(options.contexts);
});

Mustache.registerHelper('default_audit_title', function (instance, options) {
  let index;
  let program;
  let title;

  instance = Mustache.resolve(instance);
  program = instance.attr('program');

  if (!instance._transient) {
    instance.attr('_transient', new can.Map());
  }

  if (!program) {
    // Mark the title to be populated when computed_program is defined,
    // returning an empty string here would disable the save button.
    instance.attr('title', '');
    instance.attr('_transient.default_title', instance.title);
    return;
  }
  if (instance._transient.default_title !== instance.title) {
    return;
  }

  program = reify(program);
  new RefreshQueue().enqueue(program).trigger().then(function () {
    title = (new Date()).getFullYear() + ': ' + program.title + ' - Audit';

    Search.counts_for_types(title, ['Audit'])
      .then(function (result) {
        // Next audit index should be bigger by one than previous, we have unique name policy
        index = result.getCountFor('Audit') + 1;
        title = title + ' ' + index;
        instance.attr('title', title);
        // this needs to be different than above, otherwise CanJS throws a strange error
        if (instance._transient) {
          instance.attr('_transient.default_title',
            instance.title);
        }
      });
  });
});

Mustache.registerHelper('urlPath', function () {
  return window.location.pathname;
});

/*
  Evaluates multiple helpers as if they were a single condition

  Each new statement is begun with a newline-prefixed string. The type of logic
  to apply as well as whether it should be a truthy or falsy evaluation may also
  be included with the statement in addition to the helper name.

  Currently, if_helpers only supports Disjunctive Normal Form. All "and" statements are grouped,
  groups are split by "or" statements.

  All hash arguments (some_val=37) must go in the last line and should be prefixed by the
  zero-based index of the corresponding helper. This is necessary because all hash arguments
  are required to be the final arguments for a helper. Here's an example:
    _0_some_val=37 would pass some_val=37 to the first helper.

  Statement syntax:
    '\
    [LOGIC] [TRUTHY_FALSY]HELPER_NAME' arg1 arg2 argN

  Defaults:
    LOGIC = and (accepts: and or)
    TRUTHY_FALSEY = # (accepts: # ^)
    HELPER_NAME = some_helper_name

  Example:
    {{#if_helpers '\
      #if_equals' instance.status 'Assigned' '\
      and ^if_equals' instance.type 'Audit|Program|Person' '\
    ' _1_hash_arg_for_second_statement=something}}
      matched all conditions
    {{else}}
      failed
    {{/if_helpers}}

  FIXME: Only synchronous helpers (those which call options.fn() or options.inverse()
    without yielding the thread through defer_render or otherwise) can currently be used
    with if_helpers.  if_helpers should support all helpers by changing the walk through
    conjunctions and disjunctions to one using a _.reduce(Array, function (Deferred, item) {}, $.when())
    pattern instead of _.reduce(Array, function (Boolean, item) {}, Boolean) pattern. --BM 8/29/2014
*/
Mustache.registerHelper('if_helpers', function (...args) {
  let options = args[args.length - 1];
  let helperResult;
  let helperOptions = Object.assign({}, options, {
    fn: function () {
      helperResult = 'fn';
    },
    inverse: function () {
      helperResult = 'inverse';
    },
  });

  // Parse statements
  let statements = [];
  let statement;
  let match;
  let disjunctions = [];
  let index = 0;

  args.forEach(function (arg, i) {
    if (i < args.length - 1) {
      if (typeof arg === 'string' && arg.match(/^\n\s*/)) {
        if (statement) {
          if (statement.logic === 'or') {
            disjunctions.push(statements);
            statements = [];
          }
          statements.push(statement);
          index = index + 1;
        }
        if (match = arg.match(/^\n\s*((and|or) )?([#^])?(\S+?)$/)) {
          statement = {
            fn_name: match[3] === '^' ? 'inverse' : 'fn',
            helper: Mustache.getHelper(match[4], options.contexts),
            args: [],
            logic: match[2] === 'or' ? 'or' : 'and',
          };

          // Add hash arguments
          if (options.hash) {
            let hash = {};
            let prefix = '_' + index + '_';
            let prop;

            for (prop in options.hash) {
              if (prop.indexOf(prefix) === 0) {
                hash[prop.substr(prefix.length)] = options.hash[prop];
              }
            }
            if (!$.isEmptyObject(hash)) {
              statement.hash = hash;
            }
          }
        } else {
          statement = null;
        }
      } else if (statement) {
        statement.args.push(arg);
      }
    }
  });
  if (statement) {
    if (statement.logic === 'or') {
      disjunctions.push(statements);
      statements = [];
    }
    statements.push(statement);
  }
  disjunctions.push(statements);

  if (disjunctions.length) {
    // Evaluate statements
    let result = _.reduce(disjunctions,
      function (disjunctiveResult, conjunctions) {
        if (disjunctiveResult) {
          return true;
        }

        let conjunctiveResult = _.reduce(conjunctions,
          function (currentResult, stmt) {
            if (!currentResult) {
              return false;
            } // short circuit

            helperResult = null;
            stmt.helper.fn(...stmt.args.concat([
              Object.assign({}, helperOptions,
                {hash: stmt.hash || helperOptions.hash}),
            ]));
            helperResult = helperResult === stmt.fn_name;
            return currentResult && helperResult;
          }, true);
        return disjunctiveResult || conjunctiveResult;
      }, false);

    // Execute based on the result
    if (result) {
      return options.fn(options.contexts);
    } else {
      return options.inverse(options.contexts);
    }
  }
});

Mustache.registerHelper('if_in', function (needle, haystack, options) {
  needle = resolveComputed(needle);
  haystack = resolveComputed(haystack).split(',');

  let found = haystack.some(function (hay) {
    return hay.trim() === needle;
  });
  return options[found ? 'fn' : 'inverse'](options.contexts);
});

Mustache.registerHelper('if_instance_of', function (inst, cls, options) {
  let result;
  cls = resolveComputed(cls);
  inst = resolveComputed(inst);

  if (typeof cls === 'string') {
    cls = cls.split('|').map(function (cl) {
      return modalModels[cl];
    });
  } else if (typeof cls !== 'function') {
    cls = [cls.constructor];
  } else {
    cls = [cls];
  }

  result = _.find(cls, (cl) => inst instanceof cl);
  return options[result ? 'fn' : 'inverse'](options.contexts);
});

Mustache.registerHelper('prune_context', function (options) {
  return options.fn(new can.view.Scope(options.context));
});

Mustache.registerHelper('ggrc_config_value', function (key, default_, options) {
  key = resolveComputed(key);
  if (!options) {
    options = default_;
    default_ = null;
  }
  default_ = resolveComputed(default_);
  default_ = default_ || '';
  return _.get(GGRC.config, key) || default_;
});

Mustache.registerHelper('if_config_exist', function (key, options) {
  key = resolveComputed(key);
  let configValue = _.get(GGRC.config, key);

  return configValue ?
    options.fn(options.contexts) :
    options.inverse(options.contexts);
});

Mustache.registerHelper('switch', function (value, options) {
  let frame = new can.Map({});
  value = resolveComputed(value);
  frame.attr(value || 'default', true);
  frame.attr('default', true);
  return options.fn(options.contexts.add(frame), {
    helpers: {
      'case': function (val, options) {
        val = resolveComputed(val);
        if (options.context[val]) {
          options.context.attr ? options.context.attr('default', false) :
            (options.context.default = false);
          return options.fn(options.contexts);
        }
      },
    },
  });
});

Mustache.registerHelper('with_mapping_count',
  function (instance, mappingName, options) {
    let relevant;
    let dfd;

    mappingName = Mustache.resolve(mappingName);
    instance = Mustache.resolve(instance);

    relevant = {
      id: instance.id,
      type: instance.type,
    };
    dfd = batchRequests(buildCountParams([mappingName], relevant)[0]);
    return deferRender('span', {
      done: function (count) {
        return options.fn(options.contexts.add({
          count: count[mappingName].count}));
      },
      progress: function () {
        return options.inverse(options.contexts);
      },
    },
    dfd);
  });

Mustache.registerHelper('autocomplete_select', function (disableCreate, opt) {
  let options = arguments[arguments.length - 1];
  let _disableCreate = Mustache.resolve(disableCreate);

  if (typeof (_disableCreate) !== 'boolean') {
    _disableCreate = false;
  }
  return function (el) {
    $(el).bind('inserted', function () {
      let $ctl = $(this).parents(':data(controls)');
      $(this).ggrc_autocomplete($.extend({}, options.hash, {
        controller: $ctl.control(),
        disableCreate: _disableCreate,
      }));
    });
  };
});

Mustache.registerHelper('debugger', function () {
  // This just gives you a helper that you can wrap around some code in a
  // template to see what's in the context. Dev tools need to be open for this
  // to work (in Chrome at least).
  debugger; // eslint-disable-line no-debugger

  let options = arguments[arguments.length - 1];
  return options.fn(options.contexts);
});

Mustache.registerHelper('pretty_role_name', function (name) {
  name = Mustache.resolve(name);
  let ROLE_LIST = {
    ProgramOwner: 'Program Manager',
    ProgramEditor: 'Program Editor',
    ProgramReader: 'Program Reader',
    WorkflowOwner: 'Workflow Manager',
    WorkflowMember: 'Workflow Member',
    Mapped: 'No Role',
    Owner: 'Manager',
  };
  if (ROLE_LIST[name]) {
    return ROLE_LIST[name];
  }
  return name;
});

Mustache.registerHelper('role_scope', function (scope) {
  scope = Mustache.resolve(scope);

  if (scope === 'Private Program') {
    return 'Program';
  }
  return scope;
});

/*
Add new variables to current scope. This is useful for passing variables
to initialize a tree view.

Example:
  {{#add_to_current_scope example1="a" example2="b"}}
    {{log .}} // {example1: "a", example2: "b"}
  {{/add_to_current_scope}}
*/
Mustache.registerHelper('add_to_current_scope', function (options) {
  return options.fn(options.contexts
    .add(_.assign({}, options.context, options.hash)));
});

/*
Add spaces to a CamelCase string.

Example:
{{un_camel_case "InProgress"}} becomes "In Progress"
*/
Mustache.registerHelper('un_camel_case', function (str, toLowerCase) {
  let value = Mustache.resolve(str);
  toLowerCase = typeof toLowerCase !== 'object';
  if (!value) {
    return value;
  }
  value = value.replace(/([A-Z]+)/g, ' $1').replace(/([A-Z][a-z])/g, ' $1');
  return toLowerCase ? value.toLowerCase() : value;
});

Mustache.registerHelper('modifyFieldTitle', function (type, field, options) {
  let titlesMap = {
    Cycle: 'Cycle ',
    CycleTaskGroup: 'Group ',
    CycleTaskGroupObjectTask: 'Task ',
  };
  type = Mustache.resolve(type);

  return titlesMap[type] ? titlesMap[type] + field : field;
});

Mustache.registerHelper('displayWidgetTab',
  function (widget, instance, options) {
    let displayTab;
    let inForceShowList;
    widget = Mustache.resolve(widget);
    instance = Mustache.resolve(instance);

    inForceShowList = _.includes(
      instance.constructor.obj_nav_options.force_show_list,
      widget.attr('internav_display'));

    displayTab = widget.attr('has_count') &&
        widget.attr('count') ||
        widget.attr('uncountable') ||
        widget.attr('force_show') ||
        instance.constructor.obj_nav_options.show_all_tabs ||
        inForceShowList;

    if (!displayTab) {
      return options.inverse(options.contexts);
    }

    return options.fn(options.contexts);
  }
);

Mustache.registerHelper('is_auditor', function (options) {
  const audit = getPageInstance();
  if (audit.type !== 'Audit') {
    console.warn('is_auditor called on non audit page');
    return options.inverse(options.contexts);
  }

  if (isAuditor(audit, GGRC.current_user)) {
    return options.fn(options.contexts);
  }
  return options.inverse(options.contexts);
});

Mustache.registerHelper('has_role', function (role, instance, options) {
  instance = Mustache.resolve(instance);
  const acr = instance ? getRole(instance.type, role) : null;

  if (!acr) {
    return options.inverse(options.contexts);
  }

  const hasRole = !!_.find(instance.access_control_list, (item) => {
    return item.ac_role_id === acr.id &&
      item.person_id === GGRC.current_user.id;
  });

  if (hasRole) {
    return options.fn(options.contexts);
  } else {
    return options.inverse(options.contexts);
  }
});

Mustache.registerHelper('isScopeModel', function (instance, options) {
  const modelName = Mustache.resolve(instance).type;

  return isScopeModel(modelName) ? options.fn(this) : options.inverse(this);
});

/*
  Given an object, it determines if it's a workflow, and if it's a recurring
  workflow or not.

  @param object - the object we want to check
  */
Mustache.registerHelper('if_recurring_workflow', function (object, options) {
  object = Mustache.resolve(object);
  if (object.type === 'Workflow' &&
      _.includes(['day', 'week', 'month'], object.unit)) {
    return options.fn(this);
  }
  return options.inverse(this);
});
