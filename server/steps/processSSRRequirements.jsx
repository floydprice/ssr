/* eslint-disable no-undef, import/no-extraneous-dependencies, import/no-unresolved, import/extensions, max-len */
import React, { Children } from 'react';
import { StaticRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import logger from '../utils/logger';
/* eslint-enable */

// Recurse an React Element tree, running visitor on each element.
// If visitor returns `false`, don't call the element's render function
// or recurse into its child elements.

function walkTree(element, context, visitor) {
  const Component = element.type;
  // Handle stateless functional component or a class
  if (typeof Component === 'function') {
    const props = { ...Component.defaultProps, ...element.props };
    let childContext = context;
    let child;

    // Are we are a react class?
    // https://github.com/facebook/react/blob/master/src/renderers/shared/stack/reconciler/ReactCompositeComponent.js#L66
    if (Component.prototype && Component.prototype.isReactComponent) {
      const instance = new Component(props, context);
      // In case the user doesn't pass these to super in the constructor
      instance.props = instance.props || props;
      instance.context = instance.context || context;

      // Check if we can continue
      if (visitor(element, instance, context) === false) {
        return;
      }

      // Override setState to just change the state, not queue up an update.
      // (we can't do the default React thing as we aren't mounted "properly"
      // however, we don't need to re-render as well only support setState in
      // componentWillMount, which happens *before* render).
      instance.setState = (newState) => {
        instance.state = { ...instance.state, ...newState };
      };

      if (instance.componentWillMount) {
        instance.componentWillMount();
      }

      if (instance.getChildContext) {
        childContext = { ...context, ...instance.getChildContext() };
      }

      child = instance.render();
    } else {
      // We just have a stateless functional
      if (visitor(element, null, context) === false) {
        return;
      }

      child = Component(props, context);
    }

    if (child) {
      walkTree(child, childContext, visitor);
    }
  } else if (element.props && element.props.children) {
    // We have a basic string or dom element, just get children
    Children.forEach(element.props.children, (child) => {
      if (child) {
        walkTree(child, context, visitor);
      }
    });
  }
}

function processSSRRequirementsAndReturnPromises(store, rootElement, rootContext, fetchRoot) {
  const promises = [];

  walkTree(rootElement, rootContext, (element, instance, context) => {
    const skipRoot = !fetchRoot && (element === rootElement);
    if (skipRoot) return true;

    const ssrRequirements = (instance && instance.ssr) || element.type.ssr;
    if (ssrRequirements && typeof ssrRequirements === 'object') {
      const { prepareStore } = ssrRequirements;

      // Prepare the store if required
      if (typeof prepareStore === 'function') {
        const result = prepareStore(store, element.props, context);
        const isPromise = result && typeof result.then === 'function';
        if (isPromise) {
          promises.push({ promise: result, element, context });

          // Tell walkTree to not recurse inside this component;  we will
          // wait for the promise to execute before attempting it.
          return false;
        }
      }
    }

    return true;
  });

  return promises;
}

function processSSRRequirementsForElement(store, rootElement, rootContext = {}, fetchRoot = true) {
  const promises = processSSRRequirementsAndReturnPromises(
    store, rootElement, rootContext, fetchRoot,
  );

  // No promises found, nothing to do
  if (!promises.length) return Promise.resolve();
  logger.debug('processSSRRequirementsForElement waiting for Promises');
  // Wait on each promise that we found, re-rendering the subtree when it's done
  const mappedPromises = promises.map(({ promise, element, context }) =>
    // We've just grabbed the promise for element, so don't try and get it again
    promise
    .catch((err) => {
      logger.debug('Error from promise');
      logger.debug(err);
    })
    .then(() => {
      processSSRRequirementsForElement(store, element, context, false);
    }));

  return Promise.all(mappedPromises);
}

const processSSRRequirements = (stepResults) => {
  const {
    MainApp,
  } = stepResults;

  const routerContext = {};

  const app = (
    <Provider store={stepResults.store}>
      <StaticRouter location={stepResults.url} context={routerContext}>
        <MainApp />
      </StaticRouter>
    </Provider>
  );

  return processSSRRequirementsForElement(stepResults.store, app).then(() => {
    logger.debug('processSSRRequirements completed');
    return null;
  });
};

export default processSSRRequirements;
