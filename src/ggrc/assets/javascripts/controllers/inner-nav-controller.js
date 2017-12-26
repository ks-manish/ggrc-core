/*
  Copyright (C) 2017 Google Inc.
  Licensed under http://www.apache.org/licenses/LICENSE-2.0 <see LICENSE file>
*/

import {
  getPageType,
  getCounts,
} from '../plugins/utils/current-page-utils';
import {isDashboardEnabled} from '../plugins/utils/dashboards-utils';
import {isObjectVersion} from '../plugins/utils/object-versions-utils';
import router, {buildUrl} from '../router';
import '../components/add-tab-button/add-tab-button';

export default can.Control('CMS.Controllers.InnerNav', {
  defaults: {
    internav_view: '/static/mustache/dashboard/internav_list.mustache',
    pin_view: '.pin-content',
    widget_list: null,
    spinners: {},
    contexts: null,
    instance: null,
    isMenuVisible: true,
    addTabTitle: 'Add Tab',
    hideTabTitle: 'Hide',
    dividedTabsMode: false,
    priorityTabs: null,
    counts: null,
    hasHiddenWidgets: false,
  },
}, {
  init: function (options) {
    CMS.Models.DisplayPrefs.getSingleton().then(function (prefs) {
      const instance = GGRC.page_instance();
      this.display_prefs = prefs;
      this.options = new can.Map(this.options);
      if (!this.options.widget_list) {
        this.options.attr('widget_list', new can.Observe.List([]));
      }
      this.options.attr('counts', getCounts());
      this.options.attr('instance', instance);
      if (!(this.options.contexts instanceof can.Observe)) {
        this.options.attr('contexts', new can.Observe(this.options.contexts));
      }

      router.bind('widget', (ev, newVal)=>{
        this.route(newVal);
      });

      can.view(this.options.internav_view, this.options, function (frag) {
        const isAuditScope = instance.type === 'Audit';
        const fn = function () {
          this.element.append(frag);
          if (isAuditScope) {
            const priorityTabsNum = 4 +
              isDashboardEnabled(instance);
            this.element.addClass(this.options.instance.type.toLowerCase());
            this.options.attr('addTabTitle', 'Add Scope');
            this.options.attr('hideTabTitle', 'Show Audit Scope');
            this.options.attr('dividedTabsMode', true);
            this.options.attr('priorityTabs', priorityTabsNum);
          }
          this.show_hide_titles();
          this.route(router.attr('widget'));
          delete this.delayed_display;
        }.bind(this);

        this.delayed_display = {
          fn: fn,
          timeout: setTimeout(fn, 50),
        };
      }.bind(this));

      this.on();
    }.bind(this));
  },

  route: function (path) {
    var widgetList = this.options.widget_list;

    // Find and make active the widget specified by `path`
    var widget = this.widget_by_selector('#' + path);
    if (!widget && widgetList.length) {
      // Target was not found, but we can select the first widget in the list
      let widgetId = widgetList[0].internav_id + '_widget';
      router.attr('widget', widgetId);
      return;
    }
    if (widget) {
      this.set_active_widget(widget);
      return this.display_widget(widget.forceRefetch);
    }
    return new $.Deferred().resolve();
  },

  display_widget: function (refetch) {
    var activeWidgetSelector = this.options.contexts.active_widget.selector;
    var $activeWidget = $(activeWidgetSelector);
    var widgetController = $activeWidget.control();

    if (widgetController && widgetController.display) {
      return widgetController.display(refetch);
    }
    return new $.Deferred().resolve();
  },

  set_active_widget: function (widget) {
    if (typeof widget === 'string') {
      widget = this.widget_by_selector(widget);
    }

    if (widget !== this.options.contexts.attr('active_widget')) {
      widget.attr('force_show', true);
      this.update_add_more_link();
      this.options.contexts.attr('active_widget', widget);
      this.show_active_widget(widget);
    }
  },

  show_active_widget: function (widgetModel) {
    var widget = $(widgetModel.selector);
    var dashboardCtr = this.options.dashboard_controller;

    if (dashboardCtr.hideInfoPin) {
      dashboardCtr.hideInfoPin();
    }

    if (widget.length) {
      dashboardCtr.show_widget_area();
      widget.siblings().addClass('hidden').trigger('widget_hidden');
      widget.removeClass('hidden').trigger('widget_shown');
    }
  },

  widget_by_selector: function (selector) {
    return this.options.widget_list.filter((widget) => {
      return widget.selector === selector;
    })[0] || undefined;
  },

  /**
   * Sort widgets in place by their `order` attribute in ascending order.
   *
   * The widgets with non-existing / non-numeric `order` value are placed
   * at the end of the list.
   */
  sortWidgets: function () {
    this.options.attr('widget_list',
      _.sortByAll(this.options.widget_list, ['order', 'internav_display']));
  },

  update_widget_list: function (widgetElements) {
    var widgetList = this.options.widget_list.slice(0);
    var that = this;

    can.each(widgetElements, function (widgetElement, index) {
      widgetList.splice(
        can.inArray(
          that.update_widget(widgetElement, index)
          , widgetList)
        , 1);
    });

    can.each(widgetList, function (widget) {
      that.options.widget_list
        .splice(can.inArray(widget, that.options.widget_list), 1);
    });
  },

  update_widget: function (widgetElement, index) {
    var $widget = $(widgetElement);
    var widget = this.widget_by_selector('#' + $widget.attr('id'));
    var $header = $widget.find('.header h2');
    var icon = $header.find('i').attr('class');
    var menuItem = $header.text().trim();
    var match = menuItem ?
      menuItem.match(/\s*(\S.*?)\s*(?:\((?:(\d+)|\.*)(\/\d+)?\))?$/) : {};
    var title = match[1];
    var count = match[2] || undefined;
    var existingIndex;
    var widgetOptions;
    var widgetName;

    function getWidgetType(widgetId) {
      return isObjectVersion(widgetId) ? 'version' : '';
    }

    if (this.delayed_display) {
      clearTimeout(this.delayed_display.timeout);
      this.delayed_display.timeout = setTimeout(this.delayed_display.fn, 50);
    }

    // If the metadata is unrendered, find it via options
    if (!title) {
      widgetOptions = $widget.control('dashboard_widgets').options;
      widgetName = widgetOptions.widget_name;
      icon = icon || widgetOptions.widget_icon;
      // Strips html
      title = $('<div>')
        .html(typeof widgetName === 'function' ?
          widgetName() : (String(widgetName))).text();
    }
    title = title.replace(/^(Mapped|Linked|My)\s+/, '');

    // Only create the observable once, this gets updated elsewhere
    if (!widget) {
      widget = new can.Observe({
        selector: '#' + $widget.attr('id'),
        count: count,
        has_count: count != null,
        placeInAddTab: false,
      });
    }
    existingIndex = this.options.widget_list.indexOf(widget);

    widget.attr({
      internav_icon: icon,
      widgetType: getWidgetType(widgetOptions.widget_id),
      internav_display: title,
      internav_id: widgetOptions.widget_id,
      internav_href: buildUrl({widget: widgetOptions.widget_id + '_widget'}),
      forceRefetch: widgetOptions && widgetOptions.forceRefetch,
      spinner: this.options.spinners['#' + $widget.attr('id')],
      model: widgetOptions && widgetOptions.model,
      order: (widgetOptions || widget).order,
      uncountable: (widgetOptions || widget).uncountable,
    });

    index = this.options.widget_list.length;

    if (existingIndex !== index) {
      if (existingIndex > -1) {
        if (index >= this.options.widget_list.length) {
          this.options.widget_list.splice(existingIndex, 1);
          this.options.widget_list.push(widget);
        } else {
          this.options.widget_list
            .splice(existingIndex, 1, this.options.widget_list[index]);
          this.options.widget_list.splice(index, 1, widget);
        }
      } else {
        this.options.widget_list.push(widget);
      }
    }

    return widget;
  },

  update_widget_count: function ($el, count) {
    var widgetId = $el.closest('.widget').attr('id');
    var widget = this.widget_by_selector('#' + widgetId);

    if (widget) {
      widget.attr({
        count: count,
        has_count: true,
      });
    }
    this.update_add_more_link();
  },

  update_add_more_link: function () {
    var hasHiddenWidgets = false;
    var instance = this.options.instance || {};
    var model = instance.constructor;
    var showAllTabs = false;

    if (model.obj_nav_options) {
      showAllTabs = model.obj_nav_options.show_all_tabs;
    }

    if (!this.options.isMenuVisible) {
      return;
    }

    // Update has hidden widget attr
    this.options.widget_list.forEach((widget) => {
      var forceShowList = model.obj_nav_options.force_show_list;
      var forceShow = false;
      widget.attr('placeInAddTab', false);
      if (forceShowList) {
        forceShow = forceShowList.indexOf(widget.internav_display) > -1;
      }
      if (widget.has_count && widget.count === 0 &&
        !widget.force_show && !showAllTabs && !forceShow) {
        widget.attr('placeInAddTab', true);
        hasHiddenWidgets = true;
      }
    });
    this.options.attr('hasHiddenWidgets', hasHiddenWidgets);
  },

  show_hide_titles: function () {
    const pageType = getPageType();
    const originalWidgets = this.options.widget_list;
    const priorityTabsNum = this.options.attr('priorityTabs');
    const priorityTabs = originalWidgets.slice(0, priorityTabsNum);
    const notPriorityTabs = originalWidgets.slice(priorityTabsNum);

    function hideTitles(widgets) {
      widgets.forEach(function (widget) {
        widget.attr('show_title', false);
      });
    }

    function showTitles(widgets) {
      widgets.forEach(function (widget) {
        widget.attr('show_title', true);
      });
    }

    if (pageType === 'Audit') {
      showTitles(priorityTabs);
      hideTitles(notPriorityTabs);
    } else {
      showTitles(originalWidgets);
    }
  },
  '.closed click': function (el, ev) {
    let widgetSelector = el.data('widget');
    var widget = this.widget_by_selector(widgetSelector);
    var widgets = this.options.widget_list;

    widget.attr('force_show', false);
    this.route(widgets[0].selector); // Switch to the first widget
    this.update_add_more_link();
    return false; // Prevent the url change back to the widget we are hiding
  },

  // top nav dropdown position
  '.dropdown-toggle click': function (el, ev) {
    var $dropdown = el.closest('.hidden-widgets-list').find('.dropdown-menu');
    var $menuItem = $dropdown.find('.inner-nav-item').find('a');
    var offset = el.offset();
    var leftPos = offset.left;
    var win = $(window);
    var winWidth = win.width();

    if (winWidth - leftPos < 322) {
      $dropdown.addClass('right-pos');
    } else {
      $dropdown.removeClass('right-pos');
    }
    if ($menuItem.length === 1) {
      $dropdown.addClass('one-item');
    } else {
      $dropdown.removeClass('one-item');
    }
  },
  '.not-priority-hide click': function (el) {
    var count = this.options.attr('priorityTabs') + 1;
    var hiddenAreaSelector = 'li:nth-child(n+' + count + '):not(:last-child)';
    var $hiddenArea = this.element.find(hiddenAreaSelector);

    this.options.attr('isMenuVisible', !this.options.isMenuVisible);
    if (this.options.isMenuVisible) {
      $hiddenArea.show();
    } else {
      $hiddenArea.hide();
    }
  },
  '{counts} change': function () {
    this.update_add_more_link();
  },
});
