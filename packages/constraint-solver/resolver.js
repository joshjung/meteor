////////////////////////////////////////////////////////////////////////////////
// Resolver
////////////////////////////////////////////////////////////////////////////////

// XXX the whole resolver heavily relies on these statements to be true:
// - every unit version ever used was added to the resolver with addUnitVersion
// - every constraint ever used was instantiated with getConstraint
// - every constraint was added exactly once
// - every unit version was added exactly once
// - if two unit versions are the same, their refs point at the same object
// - if two constraints are the same, their refs point at the same object
ConstraintSolver.Resolver = function () {
  var self = this;

  // Maps unit name string to an array of version definitions
  self.unitsVersions = {};
  // Maps name@version string to a unit version
  self._unitsVersionsMap = {};

  // Maps unit name string to the greatest version string we have
  self._latestVersion = {};

  // Refs to all constraints. Mapping String -> instance
  self._constraints = {};
};

ConstraintSolver.Resolver.prototype.addUnitVersion = function (unitVersion) {
  var self = this;

  check(unitVersion, ConstraintSolver.UnitVersion);

  if (! _.has(self.unitsVersions, unitVersion.name)) {
    self.unitsVersions[unitVersion.name] = [];
    self._latestVersion[unitVersion.name] = unitVersion.version;
  }

  if (! _.has(self._unitsVersionsMap, unitVersion.toString())) {
    self.unitsVersions[unitVersion.name].push(unitVersion);
    self._unitsVersionsMap[unitVersion.toString()] = unitVersion;
  }

  if (semver.lt(self._latestVersion[unitVersion.name], unitVersion.version))
    self._latestVersion[unitVersion.name] = unitVersion.version;
};

// name - String - "someUnit"
// versionConstraint - String - "=1.2.3" or "2.1.0"
ConstraintSolver.Resolver.prototype.getConstraint =
  function (name, versionConstraint) {
  var self = this;

  check(name, String);
  check(versionConstraint, String);

  var idString = JSON.stringify([name, versionConstraint]);

  if (_.has(self._constraints, idString))
    return self._constraints[idString];

  return self._constraints[idString] =
    new ConstraintSolver.Constraint(name, versionConstraint);
};

// options: Object:
// - costFunction: function (choices) - given a state evaluates its cost
// - estimateCostFunction: function (state) - given a state, evaluates the
// estimated cost of the best path from state to a final state
// - combineCostFunction: function (cost, cost) - given two costs (obtained by
// evaluating states with costFunction and estimateCostFunction)
ConstraintSolver.Resolver.prototype.resolve =
  function (dependencies, constraints, choices, options) {
  var self = this;

  constraints = constraints || [];
  choices = choices || [];
  options = _.extend({
    costFunction: function (choices) { return 0; },
    estimateCostFunction: function (state) {
      return 0;
    },
    combineCostFunction: function (cost, anotherCost) {
      return cost + anotherCost;
    }
  }, options);

  var rootDependencies = _.clone(dependencies);

  dependencies = ConstraintSolver.DependenciesList.fromArray(dependencies, true);
  constraints = ConstraintSolver.ConstraintsList.fromArray(constraints);

  // create a fake unit version to represnt the app or the build target
  var appUV = new ConstraintSolver.UnitVersion("target", "1.0.0", "0.0.0");
  appUV.dependencies = dependencies;
  appUV.constraints = constraints;

  // state is an object:
  // - dependencies: DependenciesList
  // - constraints: ConstraintsList
  // - choices: array of UnitVersion
  var startState = self._propagateExactTransDeps(appUV, dependencies, constraints, choices);
  startState.choices = _.filter(startState.choices, function (uv) { return uv.name !== "target"; });

  if (options.stopAfterFirstPropagation)
    return startState.choices;

  var pq = new PriorityQueue();
  var opts = { rootDependencies: rootDependencies };
  var costFunction = options.costFunction;
  var estimateCostFunction = options.estimateCostFunction;
  var combineCostFunction = options.combineCostFunction;

  var estimatedStartingCost =
    combineCostFunction(costFunction(startState.choices, opts),
                        estimateCostFunction(startState, opts));

  pq.push(startState, [estimatedStartingCost, 0]);

  var someError = null;
  var solution = null;
  while (! pq.empty()) {
    var currentState = pq.pop();
    var tentativeCost =
      costFunction(currentState.choices, opts) +
      estimateCostFunction(currentState, opts);

    if (tentativeCost === Infinity)
      break;

    if (currentState.dependencies.isEmpty()) {
      solution = currentState.choices;
      break;
    }

    var neighborsObj = self._stateNeighbors(currentState);

    if (! neighborsObj.success) {
      someError = someError || neighborsObj.failureMsg;
    } else {
      _.each(neighborsObj.neighbors, function (state) {
        var tentativeCost =
          combineCostFunction(costFunction(state.choices, opts),
                              estimateCostFunction(state, opts));

        pq.push(state, [tentativeCost, -state.choices.length]);
      });
    }
  }

  if (solution)
    return solution;

  // XXX should be much much better
  if (someError)
    throw new Error(someError);

  throw new Error("Couldn't resolve, I am sorry");
};

// state is an object:
// - dependencies: DependenciesList - remaining dependencies
// - constraints: ConstraintsList - constraints to satisfy
// - choices: array of UnitVersion - current fixed set of choices
//
// returns {
//   success: Boolean,
//   failureMsg: String,
//   neighbors: [state]
// }
//
// NOTE: assumes that exact dependencies are already propagated
ConstraintSolver.Resolver.prototype._stateNeighbors =
  function (state) {
  var self = this;

  var dependencies = state.dependencies;
  var constraints = state.constraints;
  var choices = state.choices;

  var candidateName = dependencies.peek();
  dependencies = dependencies.remove(candidateName);

  var candidateVersions =
    _.filter(self.unitsVersions[candidateName], function (uv) {
      return !constraints.violated(uv);
    });

  if (_.isEmpty(candidateVersions))
    return { success: false,
             failureMsg: "Cannot choose satisfying versions of package -- "
                         + candidateName };

  var lastInvalidNeighbor = null;

  var neighbors = _.chain(candidateVersions).map(function (uv) {
    var nChoices = _.clone(choices);
    nChoices.push(uv);

    return self._propagateExactTransDeps(uv, dependencies, constraints, nChoices);
  }).filter(function (state) {
    var isValid =
      choicesDontViolateConstraints(state.choices, state.constraints);

    if (! isValid)
      lastInvalidNeighbor = state;

    return isValid;
  }).value();

  if (! neighbors.length)
    return { success: false,
             failureMsg: "None of the versions unit produces a sensible result -- "
               + candidateName,
             triedUnitVersions: candidateVersions,
             lastInvalidNeighbor: lastInvalidNeighbor };

  return { success: true, neighbors: neighbors };
};

// Propagates exact dependencies (which have exact constraints) from
// the given unit version taking into account the existing set of dependencies
// and constraints.
// Assumes that the unit versions graph without passed unit version is already
// propagated (i.e. doesn't try to propagate anything not related to the passed
// unit version).
ConstraintSolver.Resolver.prototype._propagateExactTransDeps =
  function (uv, dependencies, constraints, choices) {
  var self = this;

  // XXX representing a queue as an array with push/shift operations is not
  // efficient as Array.shift is O(N). Replace if it becomes a problem.
  var queue = [];
  // Boolean map to avoid adding the same stuff to queue over and over again.
  // Keeps the time complexity the same but can save some memory.
  var isEnqueued = {};

  queue.push(uv);
  isEnqueued[uv.name] = true;

  while (queue.length > 0) {
    uv = queue[0];
    queue.shift();

    choices = _.clone(choices);
    choices.push(uv);

    var exactTransitiveDepsVersions =
      uv.exactTransitiveDependenciesVersions(self);
    var inexactTransitiveDeps = uv.inexactTransitiveDependencies(self);
    var transitiveConstraints = new ConstraintSolver.ConstraintsList();
    _.each(_.union(exactTransitiveDepsVersions, [uv]), function (uv) {
      transitiveConstraints = transitiveConstraints.union(uv.constraints);
    });

    dependencies = dependencies.union(inexactTransitiveDeps);
    constraints = constraints.union(transitiveConstraints);
    choices = _.union(choices, exactTransitiveDepsVersions);

    // Since exact transitive deps are put into choices, there is no need to
    // keep them in dependencies.
    _.each(choices, function (uv) {
      dependencies = dependencies.remove(uv.name);
    });

    // There could be new combination of exact constraint/dependency outgoing
    // from existing state and the new node.
    // We don't need to look for all previously considered combinations.
    // Looking for newNode.dependencies+exact constraints and
    // newNode.exactConstraints+dependencies is enough.
    var newExactConstraintsList = uv.dependencies
      .exactConstraintsIntersection(constraints)
      .union(uv.constraints.exactDependenciesIntersection(uv.dependencies));

    var exactDeps = [];

    newExactConstraintsList.each(function (c) {
      var uv = c.getSatisfyingUnitVersion(self);
      if (! uv)
        throw new Error("No unit version was found for the constraint -- " + c.toString());
      exactDeps.push(uv);
    });

    // Enqueue all new exact dependencies.
    _.each(exactDeps, function (dep) {
      if (_.has(isEnqueued, dep.name))
        return;
      queue.push(dep);
      isEnqueued[dep.name] = true;
    });
  }

  return {
    dependencies: dependencies,
    constraints: constraints,
    choices: choices
  };
};

var choicesDontViolateConstraints = function (choices, constraints) {
  return _.all(choices, function (uv) {
    return !constraints.violated(uv);
  });
};

////////////////////////////////////////////////////////////////////////////////
// UnitVersion
////////////////////////////////////////////////////////////////////////////////

ConstraintSolver.UnitVersion = function (name, unitVersion, ecv) {
  var self = this;

  check(name, String);
  check(unitVersion, String);
  check(ecv, String);
  check(self, ConstraintSolver.UnitVersion);

  self.name = name;
  self.version = unitVersion;
  self.dependencies = new ConstraintSolver.DependenciesList();
  self.constraints = new ConstraintSolver.ConstraintsList();
  // a string in a form of "1.2.0"
  self.ecv = ecv;
};

_.extend(ConstraintSolver.UnitVersion.prototype, {
  addDependency: function (name) {
    var self = this;

    check(name, String);
    if (self.dependencies.contains(name))
      throw new Error("Dependency already exists -- " + name);
    self.dependencies = self.dependencies.push(name);
  },
  addConstraint: function (constraint) {
    var self = this;

    check(constraint, ConstraintSolver.Constraint);
    if (self.constraints.contains(constraint))
      throw new Error("Constraint already exists -- " + constraint.toString());

    self.constraints = self.constraints.push(constraint);
  },

  // Returns a list of transitive exact constraints, those could be found as
  // transitive dependencies.
  _exactTransitiveConstraints: function (resolver) {
    var self = this;

    var exactTransitiveConstraints =
      self.dependencies.exactConstraintsIntersection(self.constraints);

    exactTransitiveConstraints.each(function (c) {
      var unitVersion = c.getSatisfyingUnitVersion(resolver);
      if (! unitVersion)
        throw new Error("No unit version was found for the constraint -- " + c.toString());

      // Collect the transitive dependencies of the direct exact dependencies.
      exactTransitiveConstraints = exactTransitiveConstraints.union(
                unitVersion._exactTransitiveConstraints(resolver));
    });

    return exactTransitiveConstraints;
  },

  // XXX weirdly returns an array as opposed to some UVCollection
  exactTransitiveDependenciesVersions: function (resolver) {
    var self = this;
    var uvs = [];
    self._exactTransitiveConstraints(resolver).each(function (c) {
      var unitVersion = c.getSatisfyingUnitVersion(resolver);
      if (! unitVersion)
        throw new Error("No unit version was found for the constraint -- " + c.toString());

      uvs.push(unitVersion);
    });

    return uvs;
  },

  inexactTransitiveDependencies: function (resolver) {
    var self = this;
    var exactTransitiveConstraints = self._exactTransitiveConstraints(resolver);
    var deps = self.dependencies;

    exactTransitiveConstraints.each(function (c) {
      var unitVersion = c.getSatisfyingUnitVersion(resolver);
      if (! unitVersion)
        throw new Error("No unit version was found for the constraint -- " + c.toString());

      deps = deps.union(unitVersion.dependencies);
    });

    // remove the the exact constraints
    exactTransitiveConstraints.each(function (c) {
      deps = deps.remove(c.name);
    });

    return deps;
  },

  toString: function () {
    var self = this;
    return self.name + "@" + self.version;
  }
});

////////////////////////////////////////////////////////////////////////////////
// Constraint
////////////////////////////////////////////////////////////////////////////////

// Can be called either:
//    new PackageVersion.Constraint("packageA", "=2.1.0")
// or:
//    new PackageVersion.Constraint("pacakgeA@=2.1.0")
ConstraintSolver.Constraint = function (name, versionString) {
  var self = this;

  if (versionString) {
    _.extend(self, PackageVersion.parseVersionConstraint(versionString));
    self.name = name;
  } else {
    _.extend(self, PackageVersion.parseConstraint(name));
  }
};

ConstraintSolver.Constraint.prototype.toString = function () {
  var self = this;
  return self.name + "@" + (self.exact ? "=" : "") + self.version;
};

var semver = Npm.require('semver');

ConstraintSolver.Constraint.prototype.isSatisfied = function (unitVersion) {
  var self = this;
  check(unitVersion, ConstraintSolver.UnitVersion);

  if (self.exact)
    return self.version === unitVersion.version;

  return semver.lte(self.version, unitVersion.version) &&
    semver.lte(unitVersion.ecv, self.version);
};

// Returns any unit version satisfying the constraint in the resolver
ConstraintSolver.Constraint.prototype.getSatisfyingUnitVersion =
  function (resolver) {
  var self = this;

  if (self.exact)
    return resolver._unitsVersionsMap[self.toString().replace("=", "")];

  var unitVersion = _.find(resolver.unitsVersions[self.name],
                           _.bind(self.isSatisfied, self));
  return unitVersion;
};
