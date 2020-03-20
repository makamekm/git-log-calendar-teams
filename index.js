const GitRepository = require('./git-tools');
const YAML = require('yaml');
const path = require('path');
const colorGenerator = require('color-generator');
const fs = {
  ...require('fs'),
  ...require('fs-extra')
};
const d3Node = require('d3-node');

// Collect Stats
const DIVIDER = '-_-';
const NULL_COLOR = '#ebedf0';
const DAY_MILLISECONDS = 86400000;
const STATS_FILE_POSTFIX = '.stats.json';

// Calendar Report
const CELL_SIZE = 15;
const YEAR_HEIGHT = CELL_SIZE * 7;
const MARGIN_TOP = CELL_SIZE * 0.5;
const MARGIN_LEFT = 50;
const MARGIN_RIGHT = 10;
const WEEKS_IN_A_YEAR = 53;

// Donut Report
const DONUT_WIDTH = 900;
const DONUT_HEIGHT = 600;
const DONUT_MARGIN = 40;
const OTHERS_LABEL = '*';

// Map Report
const MAP_REPORT_WIDTH = 800;
const MAP_REPORT_LABEL_WIDTH = 200;
const DOT_COLOR = '#0095ff';

const DEFAULT_EVALUATE = item => item.linesChanged;

// Export API
module.exports = {
  collect,
  clean,
  report
};

// Load Config from YAML (Required)
async function getConfig() {
  const configPath = path.resolve(process.env.GIT_LOG_CONFIG_PATH || './git-log-config.yml');
  let config;
  if (fs.existsSync(configPath)) {
    const file = fs.readFileSync(configPath, 'utf8');
    config = YAML.parse(file);
  } else {
    const p = `\\\\rjfs2\\corpshare$\\GitStats\\git-log-config.yml`;
    if (!fs.existsSync(p)) {
      throw Error('Config file has not been found: git-log-config.yml');
    }
    const file = fs.readFileSync(p, 'utf8');
    config = YAML.parse(file);
  }
  if (config.evaluate) {
    config.evaluate = Function('"use strict";return (' + config.evaluate + ')')();
  } else {
    config.evaluate = DEFAULT_EVALUATE;
  }
  return config;
}

// Format repository name to a file name
function getRepositoryName(repository) {
  return repository.name.replace(/\W+/g, '-').toLowerCase();
}

// Collect users into invert groups (others)
function collectUnusedUsers(config) {
  let usedUsers = [];
  for (let team of config.teams) {
    team.users = team.users || [];
    if (team.invert) {
      team.users = usedUsers;
    } else {
      usedUsers = [...usedUsers, ...team.users];
    }
  }
  return usedUsers;
}

// Get default clone branch name
function getBranchName(repository, config) {
  return repository.branch || config.branch || 'master';
}

// Get all stats from a folder and return them with obsolete stats files
function readStatsFolder(config) {
  let toRemove = [];
  const fileMap = {};
  for (let file of fs.readdirSync(config.statsDir)) {
    if (file.includes(STATS_FILE_POSTFIX)) {
      const line = file.split('.')[0];
      let [repositoryName, timestamp] = line.split(DIVIDER);
      timestamp = Number.parseInt(timestamp, 10);
      const fileKey = repositoryName;
      if (!fileMap[fileKey] || fileMap[fileKey].timestamp < timestamp) {
        if (fileMap[fileKey]) {
          toRemove.push(path.resolve(config.statsDir, fileMap[fileKey].file));
        }
        fileMap[fileKey] = {
          repositoryName,
          file,
          timestamp
        };
      } else {
        toRemove.push(path.resolve(config.statsDir, file));
      }
    }
  }
  return { fileMap, toRemove };
}

// Remove all obsolete stats by checking timestamp
async function clean() {
  const config = await getConfig();
  const { toRemove } = readStatsFolder(config);
  for (let file of toRemove) {
    fs.removeSync(file);
  }
}

// Clone or update git repository
async function loadRepository(repository, config) {
  const tmpDir = path.resolve(config.tmpDir);
  fs.ensureDirSync(tmpDir);

  const repositoryName = getRepositoryName(repository);
  const repositoryPath = path.resolve(tmpDir, repositoryName);
  let pathExist = fs.existsSync(repositoryPath);
  let gitRepository = new GitRepository(repositoryPath);

  if (config.cleanTmp || repository.cleanTmp || (pathExist && !(await gitRepository.isGitRepository()))) {
    fs.removeSync(repositoryPath);
    pathExist = false;
  }

  if (!pathExist) {
    fs.ensureDirSync(repositoryPath);
    gitRepository = await GitRepository.clone({
      repo: repository.url,
      dir: repositoryPath,
      branch: getBranchName(repository, config)
    });
  } else {
    await gitRepository.checkout(getBranchName(repository, config));
  }

  return gitRepository;
}

// Collect  stats from repositories and save them into a stats folder
async function collect() {
  const config = await getConfig();
  fs.ensureDirSync(config.statsDir);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      const gitRepository = await loadRepository(repository, config);
      const authors = await gitRepository.authors();
      if (authors.length > 0) {
        const repositoryAuthorsFileName = `${repositoryName}${DIVIDER}${Date.now().toString()}${STATS_FILE_POSTFIX}`;
        fs.writeFileSync(path.resolve(config.statsDir, repositoryAuthorsFileName), JSON.stringify(authors, null, 4));
      }
    } catch (err) {
      if (process.env.DEBUG || config.debug) {
        console.error(err);
      }
    }
  }
}

// Check if the pair of email & name belongs to a reposoroty & team, but excluding the specifyed occurrences
function isAuthorBelongToRepositoryAndTeam(repository, team, users, email, name) {
  name = name.toLowerCase();
  email = email.toLowerCase();
  const user = users.find(u => u.associations.includes(email) || u.associations.includes(name));
  const excludeTeam = team.exclude && (team.exclude.includes(name) || team.exclude.includes(email));
  const excludeRepository = repository.exclude && (repository.exclude.includes(name) || repository.exclude.includes(email));
  if (user) {
    const includesTeam = team.users.includes(user.name);
    return (team.invert ? !includesTeam : includesTeam) && (!team.exclude || !excludeTeam) && (!repository.exclude || !excludeRepository);
  } else {
    const includesTeam = team.users.includes(name) || team.users.includes(email);
    return (team.invert ? !includesTeam : includesTeam) && (!team.exclude || !excludeTeam) && (!repository.exclude || !excludeRepository);
  }
}

function readStats(fileMap, config) {
  for (let repository of config.repositories) {
    const repositoryName = getRepositoryName(repository);
    if (fileMap[repositoryName]) {
      const authors = JSON.parse(fs.readFileSync(path.resolve(config.statsDir, fileMap[repositoryName].file), 'utf8'));
      fileMap[repositoryName].data = authors;
    }
  }
  return fileMap;
}

// Generate calendar reports from teams (reportCalendarTeam)
async function report() {
  const config = await getConfig();
  collectUnusedUsers(config);

  const { fileMap } = readStatsFolder(config);
  readStats(fileMap, config);

  // 1) reportCalendarTeam
  reportCalendarTeam(fileMap, config);

  // 2) reportCalendarUser
  reportCalendarUser(fileMap, config);

  // 3) reportDonutUser
  reportDonutUser(fileMap, config);

  // 4) reportMapUser
  reportMapUser(fileMap, config);
}

function reportMapUser(fileMap, config) {
  const report = config.reportMapUser;
  if (report) {
    const isAllRepositories = !report.repositories;

    const userRepositoryMap = {};

    for (let user of config.users) {
      userRepositoryMap[user.name] = [];
    }

    for (let repository of config.repositories) {
      const repositoryName = getRepositoryName(repository);
      if (fileMap[repositoryName] && (isAllRepositories || report.repositories.includes(repository.name))) {
        for (let author of fileMap[repositoryName].data) {
          const user = getAuthor(config.users, author.email, author.name);
          if (user && isAuthorBelongToRepository(repository, author.email, author.name)) {
            if (user && !userRepositoryMap[user.name].includes(repositoryName)) {
              userRepositoryMap[user.name].push(repositoryName);
            }
          }
        }
      }
    }

    const data = {
      nodes: [],
      links: []
    };

    for (const name in userRepositoryMap) {
      data.nodes.push({
        id: name,
        name: name
      });
      for (const repositoryName of userRepositoryMap[name]) {
        const users = findUsersHasRepositories(userRepositoryMap, repositoryName);
        for (const user of users) {
          if (users !== name) {
            data.links.push({
              source: name,
              target: user
            });
          }
        }
      }
    }

    generateMapReport(data, report, config);
  }
}

function findUsersHasRepositories(userRepositoryMap, repositoryName) {
  const users = [];
  for (const name in userRepositoryMap) {
    if (userRepositoryMap[name].includes(repositoryName)) {
      users.push(name);
    }
  }
  return users;
}

// Check if the pair of email & name belongs to a reposoroty, but excluding the specifyed occurrences
function isAuthorBelongToRepository(repository, email, name) {
  name = name.toLowerCase();
  email = email.toLowerCase();
  const excludeRepository = repository.exclude && (repository.exclude.includes(name) || repository.exclude.includes(email));
  return !repository.exclude || !excludeRepository;
}

// Check if the pair of email & name belongs to a reposoroty & team, but excluding the specifyed occurrences
function getAuthor(users, email, name) {
  name = name.toLowerCase();
  email = email.toLowerCase();
  return users.find(u => u.associations.includes(email) || u.associations.includes(name));
}

function reportDonutUser(fileMap, config) {
  for (let report of config.reportDonutUser || []) {
    const isAllUsers = !report.users;
    const isAllRepositories = !report.repositories;
    const isOthers = report.others;
    let data = {};

    for (let repository of config.repositories) {
      const repositoryName = getRepositoryName(repository);
      if (fileMap[repositoryName] && (isAllRepositories || report.repositories.includes(repository.name))) {
        for (let author of fileMap[repositoryName].data) {
          if (isAuthorBelongToRepository(repository, author.email, author.name)) {
            const user = getAuthor(config.users, author.email, author.name);
            const email = author.email.toLowerCase();
            const name = author.name.toLowerCase();
            let userKey = (user && user.name) || `${email} ${name}`;
            let shouldLogUser =
              isAllUsers || (user ? report.users.includes(user.name) : report.users.includes(email) || report.users.includes(name));
            if (!shouldLogUser && isOthers) {
              userKey = report.othersLabel || OTHERS_LABEL;
              shouldLogUser = true;
            }
            if (shouldLogUser) {
              if (!data[userKey]) {
                data[userKey] = 0;
              }
              if (!report.limit) {
                // Compare by total contributed lines (added + removed)
                data[userKey] += config.evaluate(author);
              } else {
                const now = new Date();
                const nowTimestamp = +now;
                const limit = new Date();
                limit.setDate(limit.getDate() - report.limit);
                const limitTimestamp = +limit;
                for (let dateString in author.map) {
                  const date = new Date(dateString);
                  const timestamp = +date;
                  if (timestamp <= nowTimestamp && timestamp >= limitTimestamp) {
                    // Compare by total contributed lines (added + removed)
                    data[userKey] += config.evaluate(author.map[dateString]);
                  }
                }
              }
            }
          }
        }
      }
    }

    if (report.top) {
      const newData = {};
      Object.keys(data)
        .sort((a, b) => data[b] - data[a])
        .splice(0, report.top)
        .forEach(key => {
          newData[key] = data[key];
        });
      data = newData;
    }

    generateDonutReport(data, report, config);
  }
}

function collectTeamDates(report, fileMap, config) {
  const teamDates = {};
  for (let team of config.teams) {
    teamDates[team.name] = {};
  }

  // Collect teams data
  for (let team of config.teams) {
    for (let repository of config.repositories) {
      const repositoryName = getRepositoryName(repository);
      if (fileMap[repositoryName] && fileMap[repositoryName].data) {
        for (let author of fileMap[repositoryName].data) {
          if (isAuthorBelongToRepositoryAndTeam(repository, team, config.users, author.email, author.name)) {
            const now = new Date();
            const nowTimestamp = +now;
            const limit = new Date();
            if (report.limit) limit.setDate(limit.getDate() - report.limit);
            const limitTimestamp = +limit;
            for (let dateString in author.map) {
              const date = new Date(dateString);
              const timestamp = +date;
              if (!report.limit || (timestamp <= nowTimestamp && timestamp >= limitTimestamp)) {
                // Compare by total contributed lines (added + removed)
                teamDates[team.name][dateString] = (teamDates[team.name][dateString] || 0) + config.evaluate(author.map[dateString]);
              }
            }
          }
        }
      }
    }
  }

  return teamDates;
}

function collectUserDates(report, fileMap, config) {
  const userDates = {};

  for (let user of config.users) {
    userDates[user.name] = {};
  }

  // Collect users data
  for (let repository of config.repositories) {
    const repositoryName = getRepositoryName(repository);
    if (fileMap[repositoryName] && fileMap[repositoryName].data) {
      for (let author of fileMap[repositoryName].data) {
        const user = getAuthor(config.users, author.email, author.name);
        if (user && isAuthorBelongToRepository(repository, author.email, author.name)) {
          const now = new Date();
          const nowTimestamp = +now;
          const limit = new Date();
          if (report.limit) limit.setDate(limit.getDate() - report.limit);
          const limitTimestamp = +limit;
          for (let dateString in author.map) {
            const date = new Date(dateString);
            const timestamp = +date;
            if (!report.limit || (timestamp <= nowTimestamp && timestamp >= limitTimestamp)) {
              // Compare by total contributed lines (added + removed)
              userDates[user.name][dateString] = (userDates[user.name][dateString] || 0) + config.evaluate(author.map[dateString]);
            }
          }
        }
      }
    }
  }

  return userDates;
}

function getCalendarData(report, fileMap, config) {
  const teamDates = collectTeamDates(report, fileMap, config);
  const userDates = collectUserDates(report, fileMap, config);
  const comparedData = [...getComparedData(teamDates, report.compareTeams || []), ...getComparedData(userDates, report.compareUsers || [])];
  return {
    teamDates,
    userDates,
    comparedData
  };
}

function reportCalendarUser(fileMap, config) {
  for (let report of config.reportCalendarUser || []) {
    const { userDates, comparedData } = getCalendarData(report, fileMap, config);
    generateCalendarReport(userDates[report.user], comparedData, report, config);
  }
}

function reportCalendarTeam(fileMap, config) {
  for (let report of config.reportCalendarTeam || []) {
    const { teamDates, comparedData } = getCalendarData(report, fileMap, config);
    generateCalendarReport(teamDates[report.team], comparedData, report, config);
  }
}

function getComparedData(dates, compareData) {
  const comparedData = [];
  for (const compareName of compareData) {
    for (const dateString in dates[compareName]) {
      comparedData.push(dates[compareName][dateString]);
    }
  }
  return comparedData;
}

function normalizeData(dates) {
  let data = [];

  for (let dateString in dates) {
    data.push({ Date: dateString, Value: dates[dateString] });
  }

  data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  data = data.reduce((acc, value) => {
    const lastDate = new Date(value.Date);
    const firstDate = acc[acc.length - 1] && new Date(acc[acc.length - 1].Date);
    if (firstDate) {
      const emptyDaysCount = lastDate / DAY_MILLISECONDS - firstDate / DAY_MILLISECONDS + 1;
      const emptyDays = [...Array(emptyDaysCount).keys()];
      const emptyDates = emptyDays.map(k => {
        const date = new Date(firstDate);
        date.setDate(date.getDate() + k + 1);
        return date;
      });
      emptyDates.forEach(date => {
        acc.push({ Date: date, Value: 0 });
      });
    }
    acc.push(value);
    return acc;
  }, []);

  return data;
}

function normalizeDataWithD3(data) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  let minYear = Infinity;
  let maxYear = 0;

  const checkYear = date => {
    const year = date.getFullYear();

    if (year > maxYear) {
      maxYear = year;
    }

    if (year < minYear) {
      minYear = year;
    }
  };

  const dateValues = data.map(dv => {
    const date = new Date(dv.Date);
    checkYear(date);
    return {
      date: d3.timeDay(date),
      value: Number(dv.Value)
    };
  });

  return {
    dateValues,
    minYear,
    maxYear
  };
}

function normalizeYearsWithD3(dateValues, comparedValueArray) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  const years = d3
    .nest()
    .key(d => d.date.getUTCFullYear())
    .entries(dateValues)
    .reverse();

  const values = dateValues.map(c => c.value);
  let maxValue = d3.max(values);
  const minValue = 0;

  if (comparedValueArray.length > 0) {
    const maxValueCompared = d3.max(comparedValueArray);
    if (maxValueCompared > maxValue) {
      maxValue = maxValueCompared;
    }
  }

  return {
    years,
    values,
    maxValue,
    minValue
  };
}

function normalizeDataForCalendarReport(dates, comparedValueArray) {
  const data = normalizeData(dates);
  const { dateValues, minYear, maxYear } = normalizeDataWithD3(data);
  const { years, maxValue, minValue } = normalizeYearsWithD3(dateValues, comparedValueArray);
  return {
    years,
    minYear,
    maxYear,
    maxValue,
    minValue
  };
}

// Generate calendar report
function generateCalendarReport(dates, comparedValueArray, report, config) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  const { years, minYear, maxYear, maxValue, minValue } = normalizeDataForCalendarReport(dates, comparedValueArray);

  if (maxYear === 0) {
    fs.removeSync(path.resolve(report.output));
    return;
  }

  const yearGap = Math.abs(maxYear - minYear);
  const [width, height] = [MARGIN_LEFT + CELL_SIZE * (WEEKS_IN_A_YEAR + 1) + MARGIN_RIGHT, YEAR_HEIGHT * (yearGap + 1) + 2 * MARGIN_TOP];
  const svg = d3n.createSVG(width, height).attr('style', `background-color: ${report.backgroundColor || 'transparent'}`);

  const group = svg.append('g');

  const year = group
    .selectAll('g')
    .data(years)
    .join('g')
    .attr('transform', (_, i) => `translate(${MARGIN_LEFT}, ${YEAR_HEIGHT * i + MARGIN_TOP})`);

  year
    .append('text')
    .attr('x', -5)
    .attr('y', -30)
    .attr('text-anchor', 'end')
    .attr('font-size', 16)
    .attr('font-weight', 550)
    .attr('font-family', 'Arial')
    .attr('transform', 'rotate(270)')
    .text(d => d.key);

  const formatDay = d => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d.getUTCDay()];
  const countDay = d => d.getUTCDay();
  const timeWeek = d3.utcSunday;
  const formatDate = d3.utcFormat('%x');
  const colorFn = d3.scaleSequential(d3[config.colorFn || 'interpolateGreens']).domain([Math.floor(minValue), Math.ceil(maxValue)]);

  year
    .append('g')
    .attr('text-anchor', 'end')
    .selectAll('text')
    .data(d3.range(7).map(i => new Date(1995, 0, i)))
    .join('text')
    .attr('x', -5)
    .attr('y', d => (countDay(d) + 0.5) * CELL_SIZE)
    .attr('dy', '0.31em')
    .attr('font-size', 12)
    .text(formatDay);

  year
    .append('g')
    .selectAll('rect')
    .data(d => d.values)
    .join('rect')
    .attr('width', CELL_SIZE - (config.padding != null ? config.padding : 3.5))
    .attr('height', CELL_SIZE - (config.padding != null ? config.padding : 3.5))
    .attr('x', d => timeWeek.count(d3.utcYear(d.date), d.date) * CELL_SIZE + 10)
    .attr('y', d => countDay(d.date) * CELL_SIZE + 0.5)
    .attr('fill', d => {
      if (d.value < 1) {
        return config.zeroColor || NULL_COLOR;
      }
      return colorFn(d.value);
    })
    .append('title')
    .text(d => `${formatDate(d.date)}: ${d.value.toFixed(2)}`);

  fs.writeFileSync(path.resolve(report.output), d3n.svgString());
}

// Generate donut report
function generateDonutReport(data, report, config) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  if (Object.keys(data).reduce((a, key) => a + data[key], 0) === 0) {
    fs.removeSync(path.resolve(report.output));
    return;
  }

  const width = report.width || DONUT_WIDTH;
  const height = report.height || DONUT_HEIGHT;
  const margin = report.margin || DONUT_MARGIN;

  // The radius of the pieplot is half the width or half the height (smallest one). I subtract a bit of margin.
  const radius = Math.min(width, height) / 2 - margin;

  const svg = d3n
    .createSVG(width, height)
    .attr('style', `background-color: ${report.backgroundColor || 'transparent'}`)
    .append('g')
    .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');

  // set the color scale
  const color = d3
    .scaleOrdinal()
    .domain(data)
    .range(Object.keys(data).map(() => colorGenerator().hexString()));

  // Compute the position of each group on the pie:
  const pie = d3
    .pie()
    .sort(null) // Do not sort group by size
    .value(d => d.value);
  const data_ready = pie(d3.entries(data));

  // The arc generator
  const arc = d3
    .arc()
    .innerRadius(radius * 0.5) // This is the size of the donut hole
    .outerRadius(radius * 0.8);

  // Another arc that won't be drawn. Just for labels positioning
  const outerArc = d3
    .arc()
    .innerRadius(radius * 0.9)
    .outerRadius(radius * 0.9);

  // Build the pie chart: Basically, each part of the pie is a path that we build using the arc function.
  svg
    .selectAll('allSlices')
    .data(data_ready)
    .enter()
    .append('path')
    .attr('d', arc)
    .attr('fill', d => color(d.data.key))
    .attr('stroke', 'white')
    .style('stroke-width', '2px')
    .style('opacity', 0.7)
    .append('title')
    .text(d => `${d.data.key}: ${d.value.toFixed(2)}`);

  // Add the polylines between chart and labels:
  svg
    .selectAll('allPolylines')
    .data(data_ready)
    .enter()
    .append('polyline')
    .attr('stroke', 'black')
    .style('fill', 'none')
    .attr('stroke-width', 1)
    .attr('points', d => {
      const posA = arc.centroid(d); // line insertion in the slice
      const posB = outerArc.centroid(d); // line break: we use the other arc generator that has been built only for that
      const posC = outerArc.centroid(d); // Label position = almost the same as posB
      const midangle = d.startAngle + (d.endAngle - d.startAngle) / 2; // we need the angle to see if the X position will be at the extreme right or extreme left
      posC[0] = radius * 0.95 * (midangle < Math.PI ? 1 : -1); // multiply by 1 or -1 to put it on the right or on the left
      return [posA, posB, posC];
    });

  // Add the polylines between chart and labels:
  svg
    .selectAll('allLabels')
    .data(data_ready)
    .enter()
    .append('text')
    .text(d => d.data.key)
    .attr('transform', d => {
      const pos = outerArc.centroid(d);
      const midangle = d.startAngle + (d.endAngle - d.startAngle) / 2;
      pos[0] = radius * 0.99 * (midangle < Math.PI ? 1 : -1);
      return 'translate(' + pos + ')';
    })
    .style('text-anchor', d => {
      const midangle = d.startAngle + (d.endAngle - d.startAngle) / 2;
      return midangle < Math.PI ? 'start' : 'end';
    });

  fs.writeFileSync(path.resolve(report.output), d3n.svgString());
}

// Generate map report
function generateMapReport(data, report, config) {
  const d3n = new d3Node();
  const d3 = d3n.d3;

  if (data.nodes.length === 0) {
    fs.removeSync(path.resolve(report.output));
    return;
  }

  // set the dimensions and margins of the graph
  const lineHeight = report.lineHeight || 16;
  const lineSpace = report.lineSpace || 16;
  const labelWidth = report.labelWidth || MAP_REPORT_LABEL_WIDTH;

  const margin = {
    top: report.marginTop || 20,
    right: report.marginRight || 30,
    bottom: report.marginBottom || 20,
    left: report.marginLeft || 30
  };
  const width = (report.width || MAP_REPORT_WIDTH) - margin.left - margin.right;
  const height = data.nodes.length * lineHeight + (data.nodes.length - 1) * lineSpace;

  // append the svg object to the body of the page
  const svg = d3n
    .createSVG(width + margin.left + margin.right, height + margin.top + margin.bottom)
    .attr('style', `background-color: ${report.backgroundColor || 'transparent'}`)
    .append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // List of node names
  const allNodes = data.nodes.map(d => d.name);

  // A linear scale to position the nodes on the X axis
  const y = d3
    .scalePoint()
    .range([0, height])
    .domain(allNodes);

  // Add links between nodes. Here is the tricky part.
  // In my input data, links are provided between nodes -id-, NOT between node names.
  // So I have to do a link between this id and the name
  const idToNode = {};
  data.nodes.forEach(n => {
    idToNode[n.id] = n;
  });
  // Cool, now if I do idToNode["2"].name I've got the name of the node with id 2

  // Add the links
  svg
    .selectAll('mylinks')
    .data(data.links)
    .enter()
    .append('path')
    .attr('d', d => {
      start = y(idToNode[d.source].name); // X position of start node on the X axis
      end = y(idToNode[d.target].name); // X position of end node
      return [
        'M',
        20 + lineHeight / 2 + labelWidth,
        start, // the arc starts at the coordinate x=start, y=height-30 (where the starting node is)
        'A', // This means we're gonna build an elliptical arc
        ((start - end) / 2) * 4,
        ',', // Next 2 lines are the coordinates of the inflexion point. Height of this point is proportional with start - end distance
        (start - end) / 2,
        0,
        0,
        ',',
        start < end ? 1 : 0,
        20 + lineHeight / 2 + labelWidth,
        ',',
        end
      ] // We always want the arc on top. So if end is before start, putting 0 here turn the arc upside down.
        .join(' ');
    })
    .style('fill', 'none')
    .attr('stroke', 'black');

  // Add the circle for the nodes
  svg
    .selectAll('mynodes')
    .data(data.nodes)
    .enter()
    .append('circle')
    .attr('cx', 30 + labelWidth)
    .attr('cy', d => y(d.name))
    .attr('r', lineHeight / 2)
    .style('fill', report.color || DOT_COLOR);

  // And give them a label
  svg
    .selectAll('mylabels')
    .data(data.nodes)
    .enter()
    .append('text')
    .attr('x', labelWidth)
    .attr('y', d => y(d.name))
    .text(d => d.name)
    .style('text-anchor', 'end')
    .style('alignment-baseline', 'middle')
    .attr('font-family', 'Arial')
    .attr('font-size', 12);

  fs.writeFileSync(path.resolve(report.output), d3n.svgString());
}
